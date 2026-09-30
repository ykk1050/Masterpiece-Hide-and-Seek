(() => {
  const socket = io();
  const $ = (s) => document.querySelector(s);
  const STORE_KEY = 'mhs-teacher';

  let state = null;
  let painting = null;
  let loadingUrl = null;
  let chars = []; // 찾기/결과 단계의 전체 캐릭터
  const monitor = new Map(); // 숨기 단계 미리보기용
  let monitorOn = false;
  let editingPainting = false; // 대기실에서 "그림 바꾸기" 중인지
  let joinUrls = [];
  let cursor = null;
  const markers = new Views.Markers();
  const roulette = new Views.Roulette();

  let selected = { kind: 'preset', id: 'starry-night' };
  const settings = {
    hideSeconds: 300, turnSeconds: 40, missesAllowed: 1,
    seekerMode: 'random', charSize: 'medium', allowEyedropper: true,
    seekRounds: 1, teacherPlays: false,
  };
  let teacherPlayToken = null;

  const teacherAct = (action, payload) =>
    new Promise((resolve) => {
      socket.emit('teacher:action', { action, payload }, (res) => {
        if (res && res.error) MHS.toast(res.error, 'bad');
        resolve(res || {});
      });
    });

  /* ---------- 명화 고르기 ---------- */

  async function buildGallery() {
    const list = await fetch('/api/paintings').then((r) => r.json());
    const g = $('#gallery');
    g.innerHTML = '';
    for (const p of list) {
      const b = document.createElement('button');
      b.className = 'art';
      b.dataset.id = p.id;
      b.innerHTML = `<div class="thumb" style="background-image:url('/api/paintings/${p.id}/thumb')"></div>
        <div class="t">${MHS.esc(p.title)}</div><div class="a">${MHS.esc(p.artist)}, ${p.year}</div>`;
      b.onclick = () => { selected = { kind: 'preset', id: p.id }; markGallery(); };
      g.appendChild(b);
    }
    const up = document.createElement('button');
    up.className = 'art upload';
    up.id = 'uploadTile';
    up.innerHTML = '<div class="thumb">＋</div><div class="t">직접 올리기</div><div class="a">내 컴퓨터의 그림 파일</div>';
    up.onclick = () => $('#uploadInput').click();
    g.appendChild(up);
    markGallery();
  }

  function markGallery() {
    document.querySelectorAll('.art').forEach((el) => {
      const on = selected.kind === 'preset' ? el.dataset.id === selected.id : el.id === 'uploadTile';
      el.classList.toggle('on', on);
    });
  }

  $('#uploadInput').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const img = new Image();
      img.src = URL.createObjectURL(file);
      await img.decode();
      const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.naturalWidth * k);
      cv.height = Math.round(img.naturalHeight * k);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      const dataUrl = cv.toDataURL('image/jpeg', 0.9);
      selected = { kind: 'upload', dataUrl, title: file.name.replace(/\.[^.]+$/, '') };
      const t = $('#uploadTile');
      t.querySelector('.thumb').style.background = `url('${dataUrl}') center / cover`;
      t.querySelector('.thumb').textContent = '';
      t.querySelector('.t').textContent = selected.title;
      markGallery();
    } catch (err) {
      MHS.toast('이미지를 읽을 수 없어요.', 'bad');
    }
  };

  /* ---------- 설정 폼 ---------- */

  function readSettingsForm() {
    settings.hideSeconds = Number($('#sHide').value);
    settings.turnSeconds = Number($('#sTurn').value);
    settings.missesAllowed = Number($('#sMiss').value);
    settings.allowEyedropper = $('#sEyedrop').checked;
    settings.seekRounds = Number($('#sRounds').value);
    settings.teacherPlays = $('#sTeacherPlays').checked;
  }

  function writeSettingsForm(s) {
    $('#sHide').value = s.hideSeconds;
    $('#sTurn').value = s.turnSeconds;
    $('#sMiss').value = s.missesAllowed;
    $('#sEyedrop').checked = s.allowEyedropper;
    $('#sRounds').value = s.seekRounds;
    $('#sTeacherPlays').checked = s.teacherPlays;
    document.querySelectorAll('.seg[data-setting]').forEach((seg) => {
      seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === s[seg.dataset.setting]));
    });
  }

  document.querySelectorAll('.seg[data-setting]').forEach((seg) => {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      settings[seg.dataset.setting] = b.dataset.v;
      seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      pushSettings();
    });
  });
  ['#sHide', '#sTurn', '#sMiss', '#sEyedrop', '#sRounds', '#sTeacherPlays'].forEach((id) => $(id).addEventListener('change', pushSettings));

  function pushSettings() {
    readSettingsForm();
    if (state && state.phase === 'lobby') teacherAct('settings', settings);
  }

  /* ---------- 방 만들기 / 다시 접속 ---------- */

  $('#createBtn').onclick = async () => {
    readSettingsForm();
    if (editingPainting) {
      const res = await teacherAct('painting', selected);
      if (!res.error) {
        editingPainting = false;
        render();
      }
      return;
    }
    $('#createBtn').disabled = true;
    socket.emit('teacher:create', { settings, painting: selected }, (res) => {
      $('#createBtn').disabled = false;
      if (res.error) return MHS.toast(res.error, 'bad');
      sessionStorage.setItem(STORE_KEY, JSON.stringify({ code: res.code, teacherToken: res.teacherToken }));
      teacherPlayToken = res.teacherPlayToken;
      onState(res.state);
    });
  };

  $('#cancelPainting').onclick = () => { editingPainting = false; render(); };
  $('#changePainting').onclick = () => { editingPainting = true; render(); };
  $('#toggleSettings').onclick = () => $('#lobbySettings').classList.toggle('hidden');
  $('#startBtn').onclick = () => teacherAct('start');

  socket.on('connect', () => {
    const saved = JSON.parse(sessionStorage.getItem(STORE_KEY) || 'null');
    if (!saved) return;
    socket.emit('teacher:rejoin', saved, (res) => {
      if (res.error) {
        sessionStorage.removeItem(STORE_KEY);
        state = null;
        render();
        return;
      }
      teacherPlayToken = res.teacherPlayToken;
      onState(res.state);
      if (monitorOn) teacherAct('monitor', { on: true });
    });
  });

  socket.on('room:state', onState);
  socket.on('room:characters', (list) => { chars = list; });
  socket.on('monitor:char', (c) => monitor.set(c.id, c));
  socket.on('seek:cursor', (c) => { cursor = c; });
  socket.on('seek:result', (r) => {
    markers.add(r);
    if (!state) return;
    const name = (id) => (state.players.find((p) => p.id === id) || {}).name || '';
    if (r.hit) MHS.toast(`찾았다! ${name(r.foundId)}`, 'ok');
    else if (r.timeout) MHS.toast('시간 초과! 다음 술래로 넘어가요', 'bad');
    else MHS.toast(r.turnOver ? '놓쳤어요! 다음 술래로 넘어가요' : '놓쳤어요!', 'bad');
  });

  async function onState(s) {
    const prevPhase = state && state.phase;
    const prevSeeker = state && state.seek && state.seek.seekerId;
    if (!s.seek || s.seek.seekerId !== prevSeeker) cursor = null;
    state = s;
    MHS.syncTime(s);
    if (s.phase === 'lobby' && prevPhase && prevPhase !== 'lobby') {
      chars = [];
      monitor.clear();
    }
    if (s.phase === 'hiding' && prevPhase !== 'hiding') monitor.clear();
    if (!painting || painting.url !== s.painting.url) ensurePainting(s.painting.url);
    render();
  }

  async function ensurePainting(url) {
    if (loadingUrl === url) return;
    loadingUrl = url;
    try {
      const p = await MHS.loadPainting(url);
      if (loadingUrl !== url) return;
      painting = p;
      teacherAct('worldSize', { w: p.w, h: p.h });
      render();
    } catch (e) {
      loadingUrl = null;
      MHS.toast(e.message, 'bad');
    }
  }

  /* ---------- 화면 그리기 ---------- */

  const PHASE_LABEL = { lobby: '대기실', hiding: '숨는 중', seeking: '찾는 중', results: '결과' };

  function render() {
    const phase = state ? state.phase : null;
    const inSetup = !state || editingPainting;
    $('#setup').classList.toggle('hidden', !inSetup);
    $('#lobby').classList.toggle('hidden', inSetup || phase !== 'lobby');
    $('#game').classList.toggle('hidden', inSetup || phase === 'lobby');
    $('#codeChip').classList.toggle('hidden', !state);
    $('#phaseChip').classList.toggle('hidden', !state);
    $('#createBtn').textContent = editingPainting ? '이 그림으로 바꾸기' : '방 만들기';
    $('#cancelPainting').classList.toggle('hidden', !editingPainting);

    // 설정 카드는 하나만 두고 위치만 옮긴다
    const home = editingPainting || !state ? $('#settingsHome') : $('#lobbySettings');
    if ($('#settingsCard').parentElement !== home) home.appendChild($('#settingsCard'));

    if (!state) return;
    $('#codeChip').textContent = '방 ' + state.code;
    $('#phaseChip').textContent = PHASE_LABEL[phase];
    Object.assign(settings, state.settings);
    writeSettingsForm(state.settings);
    roulette.update(state, null);

    if (phase === 'lobby') renderLobby();
    else renderSide();
  }

  function renderLobby() {
    $('#lobbyCode').textContent = state.code;
    $('#joinUrl').innerHTML = joinUrls.length
      ? joinUrls.map((u) => MHS.esc(u + '/play.html')).join('<br>')
      : MHS.esc(location.origin + '/play.html');
    $('#lobbyImg').src = state.painting.url;
    $('#lobbyCaption').textContent = MHS.paintingCaption(state.painting);
    $('#playerCount').textContent = `(${state.players.length}명)`;
    const box = $('#lobbyPlayers');
    box.innerHTML = '';
    if (!state.players.length) box.innerHTML = '<div class="empty">아직 들어온 학생이 없어요<span class="dots"></span></div>';
    for (const p of state.players) {
      const el = document.createElement('span');
      el.className = 'pchip' + (p.connected ? '' : ' off');
      el.appendChild(Views.avatar(p.shape));
      el.insertAdjacentHTML('beforeend', `<span>${MHS.esc(p.name)}${p.isTeacher ? ' 🧑‍🏫' : ''}</span>`);
      const x = document.createElement('button');
      x.className = 'x';
      x.title = '내보내기';
      x.textContent = '×';
      x.onclick = () => { if (confirm(`${p.name} 학생을 내보낼까요?`)) teacherAct('kick', { playerId: p.id }); };
      el.appendChild(x);
      box.appendChild(el);
    }
    const tj = $('#teacherJoinCard');
    tj.classList.toggle('hidden', !state.settings.teacherPlays || !teacherPlayToken);
    const link = `${location.origin}/play.html?code=${state.code}&t=${teacherPlayToken}`;
    $('#teacherJoinLink').href = link;
    const joined = state.players.some((p) => p.isTeacher && p.connected);
    $('#teacherJoinLink').textContent = joined ? '✅ 선생님 참여 중 · 다시 열기 ↗' : '내 캐릭터로 참여하기 ↗';
    $('#teacherJoinCopy').onclick = () => {
      navigator.clipboard.writeText(link).then(() => MHS.toast('링크를 복사했어요. 태블릿 등 다른 기기에서 열어도 돼요.', 'ok'), () => MHS.toast(link));
    };
    $('#startBtn').disabled = !state.players.length || !painting;
  }

  function statusTag(p) {
    if (state.seek && state.seek.seekerId === p.id && state.phase === 'seeking') return '<span class="tag seeker">술래</span>';
    const parts = [];
    parts.push(p.found ? '<span class="tag found">발견됨</span>' : '<span class="tag safe">숨음</span>');
    if (p.hasSought) parts.push(`<span class="tag done">${state.settings.seekRounds > 1 ? '이번 바퀴 술래 완료' : '술래 완료'}</span>`);
    return parts.join(' ');
  }

  function playerListHtml(withBars) {
    return `<ul class="plist">${state.players.map((p) => `
      <li class="${p.connected ? '' : 'muted'}">
        <span class="nm">${withBars && p.ready ? '✅ ' : ''}${MHS.esc(p.name)}${p.isTeacher ? ' 🧑‍🏫' : ''}${p.connected ? '' : ' (연결 끊김)'}</span>
        ${withBars ? `<span class="bar" title="색칠 ${p.painted}%"><i style="width:${p.painted}%"></i></span><span class="small muted" style="width:36px;text-align:right">${p.painted}%</span>` : statusTag(p)}
        ${!withBars && p.finds ? `<span class="small muted">${p.finds}명</span>` : ''}
      </li>`).join('')}</ul>`;
  }

  function renderSide() {
    const side = $('#side');
    const phase = state.phase;
    $('#gameLayout').classList.toggle('wide-side', phase === 'results');
    let html = '';

    if (phase === 'hiding') {
      html = `
        <div class="panel">
          <h3>학생들이 숨는 중이에요</h3>
          <p class="muted small" style="margin:4px 0 12px">그리기 완료 <b>${state.players.filter((p) => p.connected && p.ready).length} / ${state.players.filter((p) => p.connected).length}명</b> · 모두 완료하거나 시간이 끝나면 찾기가 시작돼요.</p>
          <div class="row">
            <button class="btn sm" data-act="addTime">+1분</button>
            <button class="btn sm primary" data-act="endHiding">지금 찾기 시작</button>
          </div>
          <label class="switch" style="margin-top:12px"><input type="checkbox" id="monitorToggle" ${monitorOn ? 'checked' : ''}> 학생 캐릭터 미리보기 (화면에 띄울 땐 끄세요)</label>
        </div>
        <div class="panel"><h3 style="margin-bottom:8px">색칠 진행도</h3>${playerListHtml(true)}</div>
        <button class="btn sm ghost" data-act="finish">게임 끝내기</button>`;
    } else if (phase === 'seeking') {
      const s = state.seek;
      const seeker = state.players.find((p) => p.id === s.seekerId);
      const hiddenCount = state.players.filter((p) => !p.found).length;
      let top = '';
      if (s.stage === 'turn') {
        top = `<div class="label-sm">지금 술래</div>
          <div class="roulette" style="font-size:28px;margin:0">${MHS.esc(seeker ? seeker.name : '')}</div>
          ${s.magnifier ? '<div class="tag seeker" style="display:inline-block;margin-bottom:6px">🔎 돋보기 찬스</div>' : ''}
          <div class="muted small">남은 기회 ${state.settings.missesAllowed - s.misses}번 · 이번 차례 남은 시간 <b id="turnLeft"></b></div>
          <div class="row" style="margin-top:10px">
            <button class="btn sm" data-act="skipTurn">차례 넘기기</button>
          </div>
          <label class="switch" style="margin-top:10px"><input type="checkbox" id="teacherClickToggle" ${state.settings.teacherClick ? 'checked' : ''}> 이 화면에서 대신 클릭하기 (프로젝터 앞에서 찾을 때)</label>`;
      } else if (s.stage === 'choosing' && state.settings.seekerMode === 'teacher') {
        const eligible = state.players.filter((p) => !p.hasSought && p.connected);
        top = `<div class="label-sm">다음 술래를 골라 주세요</div>
          <div class="players" style="margin-top:8px">${eligible.map((p) => `<button class="btn sm" data-seeker="${p.id}">${MHS.esc(p.name)}${p.isTeacher ? ' 🧑‍🏫' : ''}</button>`).join('')}</div>
          <button class="btn sm primary" style="margin-top:10px" data-act="randomSeeker">🎲 무작위로 뽑기</button>`;
      } else if (s.stage === 'choosing') {
        top = '<div class="label-sm">술래를 뽑는 중</div><div class="muted">잠시만요<span class="dots"></span></div>';
      } else {
        top = '<div class="label-sm">차례 교대</div><div class="muted">다음 술래를 준비하고 있어요<span class="dots"></span></div>';
      }
      if (state.settings.seekRounds > 1) top += `<div class="muted small" style="margin-top:8px">술래 ${s.round} / ${state.settings.seekRounds}바퀴째</div>`;
      html = `
        <div class="panel">${top}</div>
        <div class="panel">
          <div class="row" style="justify-content:space-between;margin-bottom:8px"><h3>친구들</h3><span class="muted small">아직 숨은 친구 ${hiddenCount}명</span></div>
          ${playerListHtml(false)}
        </div>
        <button class="btn sm ghost" data-act="finish">게임 끝내고 결과 보기</button>`;
    } else if (phase === 'results') {
      html = `
        <div class="panel">
          <h3 style="margin-bottom:8px">게임 결과</h3>
          ${Views.summaryHtml(state)}
          <div class="row" style="margin-top:14px">
            <button class="btn primary" data-act="reset">같은 친구들과 다시 하기</button>
          </div>
        </div>
        <div class="results-list" id="resultCards"></div>`;
    }
    side.innerHTML = html;

    side.querySelectorAll('[data-act]').forEach((b) => {
      b.onclick = () => {
        const act = b.dataset.act;
        if (act === 'finish' && !confirm('게임을 끝내고 결과를 볼까요?')) return;
        if (act === 'randomSeeker') return teacherAct('chooseSeeker', { random: true });
        teacherAct(act);
      };
    });
    side.querySelectorAll('[data-seeker]').forEach((b) => {
      b.onclick = () => teacherAct('chooseSeeker', { playerId: b.dataset.seeker });
    });
    const mt = $('#monitorToggle');
    if (mt) mt.onchange = () => { monitorOn = mt.checked; teacherAct('monitor', { on: monitorOn }); };
    const tc = $('#teacherClickToggle');
    if (tc) tc.onchange = () => teacherAct('settings', { teacherClick: tc.checked });

    if (phase === 'results' && painting && chars.length) Views.resultCards($('#resultCards'), state, chars, painting);
  }

  // 결과 단계에서 캐릭터 데이터가 상태보다 늦게 도착하는 경우 대비
  socket.on('room:characters', () => {
    if (state && state.phase === 'results') renderSide();
  });

  /* ---------- 필드(그림) 그리기 루프 ---------- */

  const field = $('#field');
  let lastView = null;

  function frame() {
    requestAnimationFrame(frame);
    if (!state || state.phase === 'lobby' || $('#game').classList.contains('hidden')) return;
    const timer = $('#timer');
    const banner = $('#banner');
    let deadline = null;

    if (state.phase === 'hiding') deadline = state.phaseDeadline;
    if (state.phase === 'seeking' && state.seek && state.seek.stage === 'turn') deadline = state.seek.deadline;
    timer.classList.toggle('hidden', !deadline);
    if (deadline) {
      const left = MHS.remaining(deadline);
      timer.textContent = MHS.fmtTime(left);
      timer.classList.toggle('low', left < 10000);
      const tl = $('#turnLeft');
      if (tl) tl.textContent = MHS.fmtTime(left);
    }

    if (!painting) return;
    let list = [];
    const outline = {}, labels = {};
    const byId = new Map(state.players.map((p) => [p.id, p]));

    if (state.phase === 'hiding') {
      banner.textContent = '🎨 숨을 자리를 찾아 그림과 똑같이 색칠하세요!';
      if (monitorOn) {
        list = [...monitor.values()].filter((c) => byId.has(c.id));
        for (const c of list) {
          outline[c.id] = 'rgba(255,255,255,0.9)';
          labels[c.id] = byId.get(c.id).name;
        }
      }
    } else {
      list = chars.filter((c) => byId.has(c.id));
      for (const c of list) {
        const p = byId.get(c.id);
        if (state.phase === 'results') {
          outline[c.id] = p.found ? '#ff8a6b' : '#f2c14e';
          labels[c.id] = p.name;
        } else if (p.found) {
          outline[c.id] = '#ff8a6b';
          labels[c.id] = p.name;
        }
      }
      if (state.phase === 'results') banner.textContent = '🏁 모두 공개! 노란 테두리는 끝까지 숨은 친구예요';
      else {
        const s = state.seek;
        const seeker = byId.get(s.seekerId);
        if (s.stage === 'turn') banner.textContent = `${s.magnifier ? '🔎 돋보기 찬스! ' : '🔍 '}${seeker ? seeker.name : ''} 술래가 찾는 중 · 아직 숨은 친구 ${state.players.filter((p) => !p.found).length}명`;
        else if (s.stage === 'choosing') banner.textContent = '다음 술래를 정하는 중…';
        else banner.textContent = '차례 교대!';
      }
    }

    const { view, ctx } = MHS.drawScene(field, painting, list, state.cell, { outline, labels });
    lastView = view;
    markers.draw(ctx, view);
    if (state.phase === 'seeking' && state.seek.stage === 'turn') {
      if (state.seek.magnifier) MHS.drawLens(field, painting, list, state.cell, view, cursor);
      Views.drawCursor(ctx, view, cursor);
    }
  }
  requestAnimationFrame(frame);

  field.addEventListener('pointerdown', (e) => {
    if (!state || state.phase !== 'seeking' || !state.settings.teacherClick || state.seek.stage !== 'turn' || !lastView) return;
    const w = MHS.toWorld(lastView, field, e);
    teacherAct('seekClick', w);
  });

  /* ---------- 시작 ---------- */
  fetch('/api/info').then((r) => r.json()).then((info) => {
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    // 인터넷 주소로 열었으면 그 주소를 그대로, 교사 PC에서 열었으면 와이파이 주소를 안내
    joinUrls = local ? info.addresses || [] : [location.origin];
    if (state && state.phase === 'lobby') renderLobby();
  }).catch(() => {});
  buildGallery();
  render();
})();
