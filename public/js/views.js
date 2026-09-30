/* 교사·학생 화면이 함께 쓰는 화면 조각 */
const Views = (() => {
  /** 작은 흰색 실루엣 아바타 */
  function avatar(shape) {
    const wrap = document.createElement('span');
    wrap.className = 'av';
    wrap.appendChild(MHS.shapePreview(shape, 20));
    return wrap;
  }

  /* ---------- 술래 뽑기 연출 ---------- */
  class Roulette {
    constructor() {
      this.el = document.createElement('div');
      this.el.className = 'overlay hidden';
      this.el.innerHTML = '<div class="card"><div class="muted small" data-k="sub"></div><div class="roulette" data-k="name"></div><div class="muted" data-k="foot"></div></div>';
      document.body.appendChild(this.el);
      this.sub = this.el.querySelector('[data-k=sub]');
      this.name = this.el.querySelector('[data-k=name]');
      this.foot = this.el.querySelector('[data-k=foot]');
      this.spin = null;
      this.lastSeeker = null;
      this.hideTimer = null;
    }
    update(state, meId) {
      const s = state.phase === 'seeking' && state.seek;
      const spinning = s && s.stage === 'choosing' && state.settings.seekerMode === 'random';
      this.pool = state.players.filter((p) => !p.hasSought && p.connected);
      if (spinning) {
        if (!this.spin) {
          let i = 0;
          this.show('다음 술래는…', '', '');
          this.spin = setInterval(() => {
            if (this.pool.length) this.name.textContent = this.pool[i++ % this.pool.length].name;
          }, 90);
        }
        return;
      }
      clearInterval(this.spin);
      this.spin = null;
      if (s && s.stage === 'turn') {
        if (s.seekerId !== this.lastSeeker) {
          this.lastSeeker = s.seekerId;
          const p = state.players.find((x) => x.id === s.seekerId);
          const mine = s.seekerId === meId;
          this.show(mine ? '두근두근!' : '이번 술래', mine ? '내가 술래예요! 🔍' : (p ? p.name : ''), '그림 전체를 보며 숨은 친구를 클릭해요');
          clearTimeout(this.hideTimer);
          this.hideTimer = setTimeout(() => this.hide(), 1800);
        }
        return;
      }
      this.lastSeeker = null;
      this.hide();
    }
    show(sub, name, foot) {
      this.sub.textContent = sub;
      this.name.textContent = name;
      this.foot.textContent = foot;
      this.el.classList.remove('hidden');
    }
    hide() {
      this.el.classList.add('hidden');
    }
  }

  /* ---------- 클릭 결과 표시 ---------- */
  class Markers {
    constructor() { this.list = []; }
    add(r) {
      if (r.x == null) return;
      this.list.push({ x: r.x, y: r.y, hit: r.hit, t: performance.now() });
    }
    draw(ctx, view) {
      const now = performance.now();
      this.list = this.list.filter((m) => now - m.t < 2600);
      const k = view.dpr / view.scale;
      for (const m of this.list) {
        const age = (now - m.t) / 2600;
        ctx.globalAlpha = 1 - age;
        ctx.lineWidth = 4 * k;
        if (m.hit) {
          ctx.strokeStyle = '#3ddc84';
          ctx.beginPath();
          ctx.arc(m.x, m.y, (18 + age * 30) * k, 0, Math.PI * 2);
          ctx.stroke();
        } else {
          const r = 14 * k;
          ctx.strokeStyle = '#ff5a3c';
          ctx.beginPath();
          ctx.moveTo(m.x - r, m.y - r); ctx.lineTo(m.x + r, m.y + r);
          ctx.moveTo(m.x + r, m.y - r); ctx.lineTo(m.x - r, m.y + r);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }
  }

  function drawCursor(ctx, view, c) {
    if (!c) return;
    const k = view.dpr / view.scale;
    ctx.lineWidth = 2 * k;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.arc(c.x, c.y, 12 * k, 0, Math.PI * 2);
    ctx.moveTo(c.x - 20 * k, c.y); ctx.lineTo(c.x - 6 * k, c.y);
    ctx.moveTo(c.x + 6 * k, c.y); ctx.lineTo(c.x + 20 * k, c.y);
    ctx.moveTo(c.x, c.y - 20 * k); ctx.lineTo(c.x, c.y - 6 * k);
    ctx.moveTo(c.x, c.y + 6 * k); ctx.lineTo(c.x, c.y + 20 * k);
    ctx.stroke();
  }

  /* ---------- 결과 ---------- */

  /** 그림 속 원래 색으로 채운 실루엣 (정답) 과 학생이 칠한 실루엣을 나란히 */
  function pairCanvases(painting, ch, cell) {
    const s = Shapes.get(ch.shape);
    const px = Math.max(2, Math.floor(84 / Math.max(s.cols, s.rows)));
    const make = (colorAt) => {
      const cv = document.createElement('canvas');
      cv.width = s.cols * px;
      cv.height = s.rows * px;
      const ctx = cv.getContext('2d');
      for (let r = 0; r < s.rows; r++) {
        for (let c = 0; c < s.cols; c++) {
          if (!s.mask[r * s.cols + c]) continue;
          ctx.fillStyle = '#' + colorAt(c, r);
          ctx.fillRect(c * px, r * px, px, px);
        }
      }
      return cv;
    };
    const original = make((c, r) => MHS.rgbToHex(MHS.sampleCell(painting, ch, cell, c, r)));
    const mine = make((c, r) => ch.pixels.substr((r * s.cols + c) * 6, 6));
    return { original, mine };
  }

  function resultCards(el, state, chars, painting) {
    el.innerHTML = '';
    const byId = new Map(state.players.map((p) => [p.id, p]));
    const rows = chars
      .filter((c) => byId.has(c.id))
      .map((c) => ({ c, p: byId.get(c.id), sim: MHS.similarity(painting, c, state.cell) }))
      .sort((a, b) => (a.p.found - b.p.found) || (b.sim - a.sim));

    for (const { c, p, sim } of rows) {
      const card = document.createElement('div');
      card.className = 'rcard' + (p.found ? '' : ' win');
      const pair = document.createElement('div');
      pair.className = 'pair';
      const { original, mine } = pairCanvases(painting, c, state.cell);
      const f1 = document.createElement('figure');
      f1.appendChild(original);
      f1.insertAdjacentHTML('beforeend', '<figcaption>그림 속 색</figcaption>');
      const f2 = document.createElement('figure');
      f2.appendChild(mine);
      f2.insertAdjacentHTML('beforeend', '<figcaption>내가 칠한 색</figcaption>');
      pair.append(f1, f2);
      card.appendChild(pair);
      const finder = p.foundBy && byId.get(p.foundBy);
      card.insertAdjacentHTML('beforeend', `
        <div class="nm"><span>${MHS.esc(p.name)}</span><span class="score">${sim}%</span></div>
        <div class="meta">${p.found ? `🔎 ${finder ? MHS.esc(finder.name) + '에게 ' : ''}발견됨` : '🏆 끝까지 숨었어요!'}${p.finds ? ` · ${p.finds}명 찾음` : ''}</div>`);
      el.appendChild(card);
    }
  }

  function summaryHtml(state) {
    const survivors = state.players.filter((p) => !p.found);
    const seekers = state.players.filter((p) => p.finds > 0).sort((a, b) => b.finds - a.finds);
    return `
      <div><div class="label-sm">위장의 달인 🏆</div>${survivors.length ? survivors.map((p) => `<span class="tag safe">${MHS.esc(p.name)}</span>`).join(' ') : '<span class="muted small">모두 발견되었어요!</span>'}</div>
      <div style="margin-top:10px"><div class="label-sm">매의 눈 🔎</div>${seekers.length ? seekers.map((p) => `<span class="tag seeker">${MHS.esc(p.name)} ${p.finds}명</span>`).join(' ') : '<span class="muted small">아무도 찾지 못했어요</span>'}</div>
      <p class="muted small" style="margin:10px 0 0">%는 캐릭터 색이 그 자리 명화의 색과 얼마나 비슷한지 나타내요.</p>`;
  }

  return { avatar, Roulette, Markers, drawCursor, resultCards, summaryHtml };
})();
