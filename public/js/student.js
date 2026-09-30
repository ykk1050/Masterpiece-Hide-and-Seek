(() => {
  const socket = io();
  const $ = (s) => document.querySelector(s);
  const STORE_KEY = 'mhs-player';

  let state = null;
  let me = null; // { id, name, shape, x, y, pixels }
  let painting = null;
  let loadingUrl = null;
  let chars = [];
  let cursor = null;
  let showWhere = false;
  let chosenShape = 'person';
  const markers = new Views.Markers();
  const roulette = new Views.Roulette();

  MHS.blockZoom();

  /* ---------- 입장 ---------- */

  const params = new URLSearchParams(location.search);
  if (params.get('code')) $('#codeInput').value = params.get('code');
  // 선생님 참여 링크(?t=...)로 들어온 경우
  const teacherPlayToken = params.get('t') || null;
  if (teacherPlayToken) $('#nameInput').value = '선생님';

  /** 모양 고르기 버튼 묶음 (입장 화면, 대기실 공용) */
  function buildShapeGrid(grid, onPick) {
    grid.innerHTML = '';
    for (const id of Shapes.ORDER) {
      const b = document.createElement('button');
      b.className = 'shape-btn';
      b.dataset.shape = id;
      const pv = document.createElement('div');
      pv.className = 'pv';
      pv.appendChild(MHS.shapePreview(id, 60));
      b.appendChild(pv);
      b.insertAdjacentHTML('beforeend', `<span>${Shapes.DEFS[id].name}</span>`);
      b.onclick = () => onPick(id);
      grid.appendChild(b);
    }
  }
  const markShape = (grid, id) => grid.querySelectorAll('.shape-btn').forEach((x) => x.classList.toggle('on', x.dataset.shape === id));

  buildShapeGrid($('#shapeGrid'), (id) => { chosenShape = id; markShape($('#shapeGrid'), id); });
  markShape($('#shapeGrid'), chosenShape);

  // 대기실: 다음 판 모양 바꾸기
  buildShapeGrid($('#waitShapeGrid'), (id) => {
    if (!me || id === me.shape) return;
    socket.emit('player:shape', { shape: id }, (res) => {
      if (res.error) return MHS.toast(res.error, 'bad');
      setMe(res.you);
      MHS.toast(`${MHS.josa(Shapes.DEFS[id].name, '으로', '로')} 바꿨어요!`, 'ok');
      render();
    });
  });

  $('#joinBtn').onclick = () => {
    const code = $('#codeInput').value.trim();
    const name = $('#nameInput').value.trim();
    if (!/^\d{4}$/.test(code)) return MHS.toast('방 번호 4자리를 입력해 주세요.', 'bad');
    if (!name) return MHS.toast('이름을 입력해 주세요.', 'bad');
    join({ code, name, shape: chosenShape, teacherPlayToken });
  };
  $('#nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#joinBtn').click(); });

  function join(data) {
    $('#joinBtn').disabled = true;
    socket.emit('player:join', data, (res) => {
      $('#joinBtn').disabled = false;
      if (res.error) {
        if (data.playerId) sessionStorage.removeItem(STORE_KEY);
        MHS.toast(res.error, 'bad');
        render();
        return;
      }
      sessionStorage.setItem(STORE_KEY, JSON.stringify({ code: data.code, playerId: res.playerId }));
      setMe(res.you);
      onState(res.state);
    });
  }

  socket.on('connect', () => {
    const saved = JSON.parse(sessionStorage.getItem(STORE_KEY) || 'null');
    if (saved) join(saved);
  });

  socket.on('kicked', () => {
    sessionStorage.removeItem(STORE_KEY);
    state = null;
    me = null;
    MHS.toast('선생님이 방에서 내보냈어요.', 'bad');
    render();
  });

  function setMe(you) {
    me = { ...you };
    editor.setCharacter(me.shape, me.pixels);
  }

  socket.on('player:you', setMe);
  socket.on('room:state', onState);
  socket.on('room:characters', (list) => {
    chars = list;
    if (state && state.phase === 'results') renderResults();
  });
  socket.on('seek:cursor', (c) => { if (!isSeeker()) cursor = c; });
  socket.on('seek:result', (r) => {
    markers.add(r);
    if (!state || !me) return;
    const name = (id) => (state.players.find((p) => p.id === id) || {}).name || '';
    if (r.hit && r.foundId === me.id) MHS.toast('앗, 들켰어요! 😳', 'bad');
    else if (r.hit) MHS.toast(`${MHS.josa(name(r.seekerId), '이', '가')} ${MHS.josa(name(r.foundId), '을', '를')} 찾았어요!`, 'ok');
    else if (r.timeout) MHS.toast('시간 초과! 술래가 바뀌어요', 'bad');
    else MHS.toast(r.turnOver ? '놓쳤어요! 술래가 바뀌어요' : '놓쳤어요!', 'bad');
  });

  function onState(s) {
    const prev = state && state.phase;
    const prevSeeker = state && state.seek && state.seek.seekerId;
    if (!s.seek || s.seek.seekerId !== prevSeeker) cursor = null;
    state = s;
    MHS.syncTime(s);
    if (s.phase === 'lobby' && prev && prev !== 'lobby') chars = [];
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
      render();
    } catch (e) {
      loadingUrl = null;
      MHS.toast(e.message, 'bad');
    }
  }

  const myPlayer = () => (state && me && state.players.find((p) => p.id === me.id)) || {};
  const amReady = () => state && state.phase === 'hiding' && !!myPlayer().ready;
  const hasLens = () => state && state.phase === 'seeking' && state.seek && state.seek.stage === 'turn' && state.seek.magnifier;

  $('#readyBtn').onclick = () => {
    const ready = !amReady();
    if (ready) socket.emit('player:paint', { pixels: editor.pixels() }); // 마지막 색칠 먼저 보내기
    socket.emit('player:ready', { ready });
  };

  const isSeeker = () => state && me && state.phase === 'seeking' && state.seek && state.seek.seekerId === me.id;

  /* ---------- 화면 전환 ---------- */

  function render() {
    const phase = state && me ? state.phase : null;
    $('#join').classList.toggle('hidden', !!phase);
    $('#wait').classList.toggle('hidden', phase !== 'lobby');
    $('#game').classList.toggle('hidden', !phase || phase === 'lobby');
    $('#meChip').classList.toggle('hidden', !phase);
    $('#paintPanel').classList.toggle('hidden', phase !== 'hiding');
    $('#seekPanel').classList.toggle('hidden', phase !== 'seeking');
    $('#resultPanel').classList.toggle('hidden', phase !== 'results');
    if (!phase) return;

    $('#meChip').textContent = `${me.name} · 방 ${state.code}`;
    roulette.update(state, me.id);

    if (phase === 'lobby') {
      const av = $('#waitAvatar');
      av.innerHTML = '';
      av.appendChild(MHS.shapePreview(me.shape, 100));
      $('#waitTitle').textContent = `${me.name}, 환영해요!`;
      markShape($('#waitShapeGrid'), me.shape);
      $('#waitImg').src = state.painting.url;
      $('#waitCaption').textContent = MHS.paintingCaption(state.painting);
      const box = $('#waitPlayers');
      box.innerHTML = '';
      for (const p of state.players) {
        const el = document.createElement('span');
        el.className = 'pchip' + (p.connected ? '' : ' off');
        el.appendChild(Views.avatar(p.shape));
        el.insertAdjacentHTML('beforeend', `<span>${MHS.esc(p.name)}${p.isTeacher ? ' 🧑‍🏫' : ''}</span>`);
        box.appendChild(el);
      }
    }
    if (phase === 'hiding') {
      const ready = amReady();
      const online = state.players.filter((p) => p.connected);
      $('#readyBtn').textContent = ready ? '✏️ 다시 그리기' : '✅ 그리기 완료';
      $('#readyBtn').classList.toggle('primary', !ready);
      $('#readyInfo').textContent = `완료한 친구 ${online.filter((p) => p.ready).length} / ${online.length}명 · 모두 완료하면 바로 찾기가 시작돼요`;
      $('#paintPanel').style.opacity = '';
      document.querySelectorAll('#paintPanel .tools, #paintPanel .sizes, #paintPanel .color-row, #paintPanel .swatches, #paintPanel .editor-wrap').forEach((el) => {
        el.style.opacity = ready ? 0.45 : '';
        el.style.pointerEvents = ready ? 'none' : '';
      });
      $('#rotInfo').textContent = `지금 ${Math.round(((me.rot || 0) * 180) / Math.PI)}°`;
      $('#paintTip').textContent = state.settings.allowEyedropper
        ? '💧 스포이드로 그림에서 색을 뽑을 수 있어요. 그래도 비슷한 색을 직접 만들어 보면 더 재미있어요!'
        : '🎨 이번 판은 스포이드로 그림 색을 뽑을 수 없어요. 밝게·어둡게·따뜻하게 버튼으로 색을 맞춰 보세요.';
    }
    if (phase === 'seeking') renderSeek();
    if (phase === 'results') renderResults();
  }

  function renderSeek() {
    const s = state.seek;
    const seeker = state.players.find((p) => p.id === s.seekerId);
    const mine = state.players.find((p) => p.id === me.id) || {};
    let html = '';
    if (s.stage === 'turn' && isSeeker()) {
      html = `<div class="label-sm">내 차례!</div><h3>숨은 친구를 찾아 클릭하세요 🔍</h3>${s.magnifier ? `<div class="tag seeker" style="display:inline-block;margin-top:6px">🔎 돋보기 찬스 (${MHS.LENS.zoom}배)</div>` : ''}
        <p class="muted small" style="margin:6px 0 0">남은 기회 <b>${state.settings.missesAllowed - s.misses}번</b> · 남은 시간 <b id="turnLeft"></b><br>찾으면 계속, 놓치면 다른 친구에게 차례가 넘어가요.</p>`;
    } else if (s.stage === 'turn') {
      html = `<div class="label-sm">지금 술래</div><h3>${MHS.esc(seeker ? seeker.name : '')}</h3>
        <p class="muted small" style="margin:6px 0 0">남은 시간 <b id="turnLeft"></b></p>`;
    } else if (s.stage === 'choosing') {
      html = `<div class="label-sm">다음 술래</div><h3>${state.settings.seekerMode === 'teacher' ? '선생님이 고르고 있어요' : '뽑는 중'}<span class="dots"></span></h3>`;
    } else {
      html = '<div class="label-sm">차례 교대</div><h3>잠시만요<span class="dots"></span></h3>';
    }
    if (state.settings.seekRounds > 1) html += `<div class="muted small" style="margin-top:6px">술래 ${s.round} / ${state.settings.seekRounds}바퀴째</div>`;
    html += `<div style="margin-top:10px">${mine.found ? '<span class="tag found">나는 들켰어요</span>' : '<span class="tag safe">나는 아직 숨어 있어요 🤫</span>'} ${mine.hasSought ? '<span class="tag done">이번 바퀴 술래 완료</span>' : ''}</div>`;
    $('#seekStatus').innerHTML = html;
    $('#whereBtn').classList.toggle('hidden', !!mine.found);
    $('#seekPlayers').innerHTML = `<ul class="plist">${state.players.map((p) => `
      <li><span class="nm">${MHS.esc(p.name)}${p.isTeacher ? ' 🧑‍🏫' : ''}${p.id === me.id ? ' (나)' : ''}</span>
      ${p.id === s.seekerId ? '<span class="tag seeker">술래</span>' : p.found ? '<span class="tag found">발견됨</span>' : '<span class="tag safe">숨음</span>'}
      ${p.finds ? `<span class="small muted">${p.finds}명</span>` : ''}</li>`).join('')}</ul>`;
  }

  function renderResults() {
    $('#resultSummary').innerHTML = '<h3 style="margin-bottom:8px">게임 결과</h3>' + Views.summaryHtml(state);
    if (painting && chars.length) Views.resultCards($('#resultCards'), state, chars, painting);
  }

  /* ---------- 색칠 도구 ---------- */

  let lastPaintSent = 0, paintTimer = null;
  const editor = new PaintEditor($('#editor'), {
    getPainting: () => painting,
    isLocked: () => amReady(),
    getMe: () => me,
    getCell: () => (state ? state.cell : 2.6),
    canPickPainting: () => state && state.settings.allowEyedropper,
    onPick: (hex) => {
      setColor(hex);
      setTool('brush');
    },
    onChange: (pixels, final) => {
      me.pixels = pixels;
      clearTimeout(paintTimer);
      const send = () => {
        lastPaintSent = Date.now();
        socket.emit('player:paint', { pixels });
      };
      if (final || Date.now() - lastPaintSent > 400) send();
      else paintTimer = setTimeout(send, 400);
      if (final && (editor.tool === 'brush' || editor.tool === 'fill')) addRecent(editor.color);
    },
  });

  function setTool(t) {
    editor.tool = t;
    document.querySelectorAll('#tools .tool').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
  }
  document.querySelectorAll('#tools .tool').forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));
  $('#undoBtn').onclick = () => editor.undo();
  document.querySelectorAll('#sizes button').forEach((b) => {
    b.onclick = () => {
      editor.size = Number(b.dataset.size);
      document.querySelectorAll('#sizes button').forEach((x) => x.classList.toggle('on', x === b));
    };
  });
  $('#gridToggle').onchange = (e) => { editor.grid = e.target.checked; };

  const peekOn = () => { editor.peek = true; };
  const peekOff = () => { editor.peek = false; };
  $('#peekBtn').addEventListener('pointerdown', peekOn);
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((t) => $('#peekBtn').addEventListener(t, peekOff));

  function setColor(hex) {
    editor.color = hex;
    $('#colorInput').value = '#' + hex;
    $('#swatchNow').style.background = '#' + hex;
    if (editor.tool === 'eraser') setTool('brush');
  }
  $('#colorInput').addEventListener('input', (e) => setColor(e.target.value.slice(1)));

  document.querySelectorAll('[data-adj]').forEach((b) => {
    b.onclick = () => {
      const rgb = MHS.hexToRgb(editor.color);
      let out;
      const [h, s, l] = MHS.rgbToHsl(rgb);
      switch (b.dataset.adj) {
        case 'lighter': out = MHS.hslToRgb([h, s, Math.min(1, l + 0.06)]); break;
        case 'darker': out = MHS.hslToRgb([h, s, Math.max(0, l - 0.06)]); break;
        case 'vivid': out = MHS.hslToRgb([h, Math.min(1, s + 0.08), l]); break;
        case 'dull': out = MHS.hslToRgb([h, Math.max(0, s - 0.08), l]); break;
        case 'warm': out = [rgb[0] + 10, rgb[1] + 3, rgb[2] - 10]; break;
        case 'cool': out = [rgb[0] - 10, rgb[1], rgb[2] + 10]; break;
      }
      setColor(MHS.rgbToHex(out));
    };
  });

  const PALETTE = [
    '111111', '4a4a4a', '8c8c8c', 'd9d9d9', 'fbf7ee', '5a3a22', '8b5a2b', 'c49a6c', 'e8cfa6', 'f2d7c1',
    'b3261e', 'e0533b', 'f28c28', 'f2c14e', 'fff08a', '2f5d34', '6a994e', 'a7c957', '1d3557', '2f6db5',
    '6fb1e0', '2a9d8f', '6a4c93', 'c77dff', 'e89bb5', '9e2a2b', 'bc6c25', '606c38', '283618', '0b132b',
  ];
  const pal = $('#palette');
  for (const hex of PALETTE) {
    const b = document.createElement('button');
    b.style.background = '#' + hex;
    b.title = '#' + hex;
    b.onclick = () => setColor(hex);
    pal.appendChild(b);
  }
  let recent = [];
  function addRecent(hex) {
    recent = [hex, ...recent.filter((x) => x !== hex)].slice(0, 10);
    const box = $('#recent');
    box.innerHTML = '';
    for (const h of recent) {
      const b = document.createElement('button');
      b.style.background = '#' + h;
      b.onclick = () => setColor(h);
      box.appendChild(b);
    }
  }
  setColor(editor.color);

  window.addEventListener('keydown', (e) => {
    if (!state || state.phase !== 'hiding' || !me) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
      e.preventDefault();
      editor.undo();
      return;
    }
    if ((e.key === 'q' || e.key === 'e' || e.key === 'Q' || e.key === 'E') && document.activeElement.tagName !== 'INPUT') {
      if (amReady()) return;
      rotateMe((me.rot || 0) + ((e.key.toLowerCase() === 'e' ? 15 : -15) * Math.PI) / 180, true);
      return;
    }
    const step = state.cell;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (d && document.activeElement.tagName !== 'INPUT') {
      e.preventDefault();
      if (amReady()) return;
      moveMe(me.x + d[0], me.y + d[1], true);
    }
  });

  $('#whereBtn').addEventListener('pointerdown', () => { showWhere = true; });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((t) => $('#whereBtn').addEventListener(t, () => { showWhere = false; }));

  /* ---------- 필드(그림판) ---------- */

  const field = $('#field');
  let lastView = null;
  let drag = null;
  let lastMoveSent = 0;

  function charSize() {
    const s = Shapes.get(me.shape);
    return { w: s.cols * state.cell, h: s.rows * state.cell };
  }

  function moveMe(x, y, final) {
    Object.assign(me, Shapes.clampPos({ ...me, x, y }, state.cell, painting));
    if (final || Date.now() - lastMoveSent > 80) {
      lastMoveSent = Date.now();
      socket.emit('player:move', { x: me.x, y: me.y, rot: me.rot || 0 });
    }
  }

  function rotateMe(rot, final) {
    me.rot = Shapes.normAngle(rot);
    moveMe(me.x, me.y, final); // 돌리면서 그림 밖으로 나가지 않게 위치도 다시 맞춤
    $('#rotInfo').textContent = `지금 ${Math.round((me.rot * 180) / Math.PI)}°`;
  }

  document.querySelectorAll('#rotateRow [data-rot]').forEach((b) => {
    b.onclick = () => {
      if (amReady() || !me) return;
      const d = Number(b.dataset.rot);
      rotateMe(d === 0 ? 0 : (me.rot || 0) + (d * Math.PI) / 180, true);
    };
  });

  /* 회전 입력: 컴퓨터는 우클릭한 채 끌기, 태블릿은 두 손가락으로 돌리기 */
  const touches = new Map(); // pointerId → 화면 좌표
  let rotating = null; // { startAngle, startRot, mode }
  const centerOnScreen = () => {
    const f = Shapes.frame(me, state.cell);
    const rect = field.getBoundingClientRect();
    return {
      x: rect.left + (lastView.ox + f.cx * lastView.scale) / lastView.dpr,
      y: rect.top + (lastView.oy + f.cy * lastView.scale) / lastView.dpr,
    };
  };
  const angleOfTouches = () => {
    const [a, b] = [...touches.values()];
    return Math.atan2(b.y - a.y, b.x - a.x);
  };
  field.addEventListener('contextmenu', (e) => e.preventDefault());

  let seekPending = false;
  field.addEventListener('pointerdown', (e) => {
    if (!state || !me || !painting || !lastView) return;
    const w = MHS.toWorld(lastView, field, e);
    if (state.phase === 'hiding') {
      if (amReady()) return MHS.toast('그리기 완료 상태예요. 고치려면 [다시 그리기]를 누르세요.');
      try { field.setPointerCapture(e.pointerId); } catch (err) { /* 캡처 실패해도 계속 */ }
      if (e.pointerType === 'touch') {
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (touches.size === 2) {
          // 두 손가락: 이동을 멈추고 회전 시작
          drag = null;
          rotating = { startAngle: angleOfTouches(), startRot: me.rot || 0, mode: 'touch' };
          return;
        }
        if (touches.size > 2 || rotating) return;
      }
      if (e.button === 2) {
        const c = centerOnScreen();
        rotating = { startAngle: Math.atan2(e.clientY - c.y, e.clientX - c.x), startRot: me.rot || 0, mode: 'mouse' };
        return;
      }
      const { w: cw, h: ch } = charSize();
      const l = Shapes.toLocal(me, state.cell, w.x, w.y);
      const s0 = Shapes.get(me.shape);
      const inside = l.c >= 0 && l.r >= 0 && l.c <= s0.cols && l.r <= s0.rows;
      drag = inside ? { dx: w.x - me.x, dy: w.y - me.y } : { dx: cw / 2, dy: ch / 2 };
      moveMe(w.x - drag.dx, w.y - drag.dy, false);
    } else if (isSeeker() && state.seek.stage === 'turn' && !seekPending && !confirmAt) {
      if (e.pointerType !== 'touch') return sendSeek(w);
      // 터치: 한 번 탭은 살펴보기, 빠르게 두 번 탭하면 선택 → 확인 창
      cursor = w;
      socket.emit('seek:cursor', w);
      const now = performance.now();
      const near = lastTap && Math.hypot(e.clientX - lastTap.cx, e.clientY - lastTap.cy) < 40;
      if (lastTap && now - lastTap.t < 350 && near) {
        lastTap = null;
        askConfirm(w);
      } else {
        lastTap = { t: now, cx: e.clientX, cy: e.clientY };
      }
    }
  });

  let lastTap = null;
  let isTouch = matchMedia('(pointer: coarse)').matches;
  field.addEventListener('pointerdown', (e) => { isTouch = e.pointerType === 'touch'; }, true);
  let confirmAt = null;
  function sendSeek(w) {
    seekPending = true;
    socket.emit('seek:click', w, (res) => {
      seekPending = false;
      if (res && res.error) MHS.toast(res.error, 'bad');
    });
  }

  const confirmBox = document.createElement('div');
  confirmBox.className = 'overlay hidden';
  confirmBox.style.background = 'rgba(20,16,12,.25)';
  confirmBox.innerHTML = `<div class="card">
      <h3 style="margin-bottom:6px">이 위치에 친구가 숨어 있다고 생각하나요?</h3>
      <p class="muted small" style="margin:0 0 14px">노란 표시가 있는 곳을 선택해요.</p>
      <div class="row" style="justify-content:center">
        <button class="btn big" data-c="no">아니요, 다시 볼래요</button>
        <button class="btn big primary" data-c="yes">네, 여기예요!</button>
      </div></div>`;
  document.body.appendChild(confirmBox);
  function askConfirm(w) {
    confirmAt = w;
    confirmBox.classList.remove('hidden');
  }
  function closeConfirm() {
    confirmAt = null;
    confirmBox.classList.add('hidden');
  }
  confirmBox.querySelector('[data-c=yes]').onclick = () => {
    const w = confirmAt;
    closeConfirm();
    if (w && isSeeker() && state.seek.stage === 'turn') sendSeek(w);
  };
  confirmBox.querySelector('[data-c=no]').onclick = closeConfirm;
  // 차례가 끝나면(시간 초과 등) 확인 창도 닫기
  socket.on('room:state', () => { if (confirmAt && !(isSeeker() && state.seek.stage === 'turn')) closeConfirm(); });
  field.addEventListener('pointermove', (e) => {
    if (!lastView || !state) return;
    const w = MHS.toWorld(lastView, field, e);
    if (state.phase === 'hiding' && touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (rotating && state.phase === 'hiding') {
      let now;
      if (rotating.mode === 'touch') {
        if (touches.size < 2) return;
        now = angleOfTouches();
      } else {
        const c = centerOnScreen();
        now = Math.atan2(e.clientY - c.y, e.clientX - c.x);
      }
      rotateMe(rotating.startRot + (now - rotating.startAngle), false);
      return;
    }
    if (drag && state.phase === 'hiding') moveMe(w.x - drag.dx, w.y - drag.dy, false);
    if (isSeeker()) {
      cursor = w;
      socket.emit('seek:cursor', w);
    }
  });
  const endDrag = (e) => {
    if ((drag || rotating) && state && state.phase === 'hiding') moveMe(me.x, me.y, true);
    drag = null;
    touches.delete(e.pointerId);
    // 두 손가락 회전은 손가락을 모두 뗄 때까지 유지 (한 손가락이 남아도 갑자기 이동하지 않도록)
    if (!rotating || rotating.mode === 'mouse' || touches.size === 0) rotating = null;
  };
  field.addEventListener('pointerup', endDrag);
  field.addEventListener('pointercancel', endDrag);

  function frame() {
    requestAnimationFrame(frame);
    if (!state || !me || state.phase === 'lobby') return;

    let deadline = null;
    if (state.phase === 'hiding') deadline = state.phaseDeadline;
    if (state.phase === 'seeking' && state.seek && state.seek.stage === 'turn') deadline = state.seek.deadline;
    const timer = $('#timer');
    timer.classList.toggle('hidden', !deadline);
    if (deadline) {
      const left = MHS.remaining(deadline);
      timer.textContent = MHS.fmtTime(left);
      timer.classList.toggle('low', left < 10000);
      const tl = $('#turnLeft');
      if (tl) tl.textContent = MHS.fmtTime(left);
    }
    if (!painting) return;

    const banner = $('#banner');
    const hint = $('#hint');
    const byId = new Map(state.players.map((p) => [p.id, p]));
    let list = [];
    const outline = {}, labels = {};

    if (state.phase === 'hiding') {
      list = [{ ...me }];
      const pulse = 0.55 + 0.45 * Math.sin(performance.now() / 250);
      if (!drag && !rotating) outline[me.id] = `rgba(255, 209, 102, ${pulse.toFixed(2)})`;
      banner.textContent = amReady() ? '✅ 그리기 완료! 친구들을 기다리는 중…' : '🎨 자리를 잡고 그 자리 그림과 똑같이 색칠하세요!';
      banner.classList.remove('me');
      hint.textContent = isTouch
        ? '끌어서 옮기기 · 두 손가락으로 돌리기'
        : '끌어서 옮기기 · 우클릭한 채 끌어서 돌리기 · 방향키 이동 · Q/E 회전';
      editor.render();
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
        } else if (c.id === me.id && showWhere) {
          outline[c.id] = '#ffd166';
        }
      }
      const s = state.seek;
      banner.classList.toggle('me', !!isSeeker());
      if (state.phase === 'results') {
        banner.textContent = '🏁 모두 공개! 노란 테두리는 끝까지 숨은 친구예요';
        hint.textContent = '';
      } else if (isSeeker() && s.stage === 'turn') {
        banner.textContent = s.magnifier ? `🔎 돋보기 찬스! ${MHS.LENS.zoom}배로 보며 찾아보세요` : '🔍 내가 술래! 숨은 친구를 찾아 클릭하세요';
        hint.textContent = (isTouch ? '👆 한 번 탭: 살펴보기 · 두 번 탭: 선택  ' : '') + (s.magnifier ? `${state.settings.magnifierAfter}번 연속으로 못 찾아서 돋보기가 생겼어요. 누군가 찾을 때까지 계속 쓸 수 있어요!` : '그림은 확대할 수 없어요. 눈을 크게 뜨고 찾아보세요!');
      } else {
        const seeker = byId.get(s.seekerId);
        banner.textContent = s.stage === 'turn' ? `🔍 ${seeker ? seeker.name : ''} 술래가 찾는 중…` : '다음 술래를 정하는 중…';
        hint.textContent = '';
      }
    }

    const { view, ctx } = MHS.drawScene(field, painting, list, state.cell, { outline, labels });
    lastView = view;
    markers.draw(ctx, view);
    if (state.phase === 'seeking' && state.seek.stage === 'turn') {
      if (hasLens()) MHS.drawLens(field, painting, list, state.cell, view, cursor);
      Views.drawCursor(ctx, view, cursor);
      if (confirmAt) {
        const k = view.dpr / view.scale;
        ctx.lineWidth = 4 * k;
        ctx.strokeStyle = '#ffd166';
        ctx.beginPath();
        ctx.arc(confirmAt.x, confirmAt.y, 16 * k, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }
  requestAnimationFrame(frame);

  render();
})();
