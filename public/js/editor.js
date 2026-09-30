/*
 * 색칠 도구: 캐릭터 주변 명화를 크게 확대해서 보여 주고,
 * 격자 한 칸씩 붓·채우기·스포이드·지우개로 색칠한다.
 */
class PaintEditor {
  constructor(canvas, opts) {
    this.canvas = canvas;
    this.opts = opts; // { getPainting, getMe, getCell, canPickPainting, onChange, onPick }
    this.tool = 'brush';
    this.size = 1;
    this.color = '3a5a8c';
    this.grid = false;
    this.peek = false;
    this.px = [];
    this.shape = 'person';
    this.undoStack = [];
    this.hover = null;
    this.drawing = false;
    this.last = null;
    this.MARGIN = 5;

    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointercancel', (e) => this.up(e));
    canvas.addEventListener('pointerleave', () => { this.hover = null; });
  }

  setCharacter(shape, pixels) {
    this.shape = shape;
    const s = Shapes.get(shape);
    this.px = [];
    for (let i = 0; i < s.cols * s.rows; i++) this.px.push(pixels.substr(i * 6, 6));
    this.undoStack = [];
  }

  pixels() {
    return this.px.join('');
  }

  /* ---------- 좌표 ---------- */

  layout() {
    const s = Shapes.get(this.shape);
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    if (this.canvas.width !== W || this.canvas.height !== W) {
      this.canvas.width = W;
      this.canvas.height = W;
    }
    const span = Math.max(s.cols, s.rows) + this.MARGIN * 2;
    const cellPx = W / span;
    const padC = (span - s.cols) / 2, padR = (span - s.rows) / 2;
    const me = this.opts.getMe();
    const cell = this.opts.getCell();
    // 캐릭터는 똑바로 세워 두고, 캐릭터가 돌아간 만큼 뒤의 명화를 반대로 돌려서 보여 준다
    return { s, W, span, cellPx, dpr, cell, me, ox: padC * cellPx, oy: padR * cellPx };
  }

  eventCell(e) {
    const L = this.layout();
    const rect = this.canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * L.dpr, y = (e.clientY - rect.top) * L.dpr;
    const c = (x - L.ox) / L.cellPx, r = (y - L.oy) / L.cellPx;
    const w = Shapes.toWorld(L.me, L.cell, c, r);
    return { c: Math.floor(c), r: Math.floor(r), wx: w.x, wy: w.y, L };
  }

  inMask(c, r) {
    const s = Shapes.get(this.shape);
    return c >= 0 && r >= 0 && c < s.cols && r < s.rows && s.mask[r * s.cols + c];
  }

  footprint(c, r) {
    const n = this.size, o = Math.floor((n - 1) / 2), out = [];
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const corner = n >= 3 && (i === 0 || i === n - 1) && (j === 0 || j === n - 1);
        if (!corner) out.push([c - o + i, r - o + j]);
      }
    }
    return out;
  }

  /* ---------- 입력 ---------- */

  down(e) {
    e.preventDefault();
    if (this.opts.isLocked && this.opts.isLocked()) return;
    try { this.canvas.setPointerCapture(e.pointerId); } catch (err) { /* 캡처 실패해도 계속 */ }
    const p = this.eventCell(e);
    this.hover = p;
    if (this.tool === 'picker') return this.pick(p);
    this.pushUndo();
    if (this.tool === 'fill') {
      this.fill(p.c, p.r);
      this.changed(true);
      return;
    }
    this.drawing = true;
    this.last = p;
    this.stamp(p.c, p.r);
    this.changed(false);
  }

  move(e) {
    const p = this.eventCell(e);
    this.hover = p;
    if (!this.drawing) return;
    // 빠르게 움직여도 빈틈이 생기지 않도록 이전 칸과 선으로 잇는다
    let x0 = this.last.c, y0 = this.last.r;
    const x1 = p.c, y1 = p.r;
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (let guard = 0; guard < 200; guard++) {
      this.stamp(x0, y0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
    this.last = p;
    this.changed(false);
  }

  up() {
    if (this.drawing) {
      this.drawing = false;
      this.changed(true);
    }
  }

  stamp(c, r) {
    const color = this.tool === 'eraser' ? 'ffffff' : this.color;
    const s = Shapes.get(this.shape);
    for (const [x, y] of this.footprint(c, r)) {
      if (this.inMask(x, y)) this.px[y * s.cols + x] = color;
    }
  }

  fill(c, r) {
    if (!this.inMask(c, r)) return;
    const s = Shapes.get(this.shape);
    const target = this.px[r * s.cols + c];
    if (target === this.color) return;
    const stack = [[c, r]];
    while (stack.length) {
      const [x, y] = stack.pop();
      if (!this.inMask(x, y) || this.px[y * s.cols + x] !== target) continue;
      this.px[y * s.cols + x] = this.color;
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
  }

  pick(p) {
    const s = Shapes.get(this.shape);
    let hex = null;
    if (!this.peek && this.inMask(p.c, p.r)) {
      hex = this.px[p.r * s.cols + p.c];
    } else {
      if (!this.opts.canPickPainting()) {
        MHS.toast('선생님이 그림에서 색 뽑기를 막아 두었어요. 직접 색을 만들어 보세요!', 'bad');
        return;
      }
      const painting = this.opts.getPainting();
      const cell = p.L.cell;
      if (p.wx < 0 || p.wy < 0 || p.wx >= painting.w || p.wy >= painting.h) return;
      hex = MHS.rgbToHex(MHS.sampleAvg(painting, p.wx - cell / 2, p.wy - cell / 2, cell, cell));
    }
    this.opts.onPick(hex);
  }

  pushUndo() {
    this.undoStack.push(this.pixels());
    if (this.undoStack.length > 40) this.undoStack.shift();
  }

  undo() {
    const prev = this.undoStack.pop();
    if (!prev) return;
    const s = Shapes.get(this.shape);
    for (let i = 0; i < s.cols * s.rows; i++) this.px[i] = prev.substr(i * 6, 6);
    this.changed(true);
  }

  changed(final) {
    this.opts.onChange(this.pixels(), final);
  }

  /* ---------- 그리기 ---------- */

  render() {
    const painting = this.opts.getPainting();
    if (!painting) return;
    const L = this.layout();
    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#1a1714';
    ctx.fillRect(0, 0, L.W, L.W);

    // 캐릭터 주변 명화: 캐릭터 중심을 편집 창의 캐릭터 중심에 맞추고 반대로 회전
    const { s, cellPx, ox, oy } = L;
    const f = Shapes.frame(L.me, L.cell);
    ctx.save();
    ctx.translate(ox + (s.cols * cellPx) / 2, oy + (s.rows * cellPx) / 2);
    ctx.rotate(-(L.me.rot || 0));
    ctx.scale(cellPx / L.cell, cellPx / L.cell);
    ctx.translate(-f.cx, -f.cy);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(painting.canvas, 0, 0);
    ctx.restore();

    if (!this.peek) {
      for (let r = 0; r < s.rows; r++) {
        for (let c = 0; c < s.cols; c++) {
          const i = r * s.cols + c;
          if (!s.mask[i]) continue;
          ctx.fillStyle = '#' + this.px[i];
          const x0 = Math.floor(ox + c * cellPx), y0 = Math.floor(oy + r * cellPx);
          ctx.fillRect(x0, y0, Math.floor(ox + (c + 1) * cellPx) - x0, Math.floor(oy + (r + 1) * cellPx) - y0);
        }
      }
    }

    if (this.grid) {
      ctx.strokeStyle = 'rgba(0,0,0,0.18)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let r = 0; r < s.rows; r++) {
        for (let c = 0; c < s.cols; c++) {
          if (s.mask[r * s.cols + c]) ctx.rect(ox + c * cellPx + 0.5, oy + r * cellPx + 0.5, cellPx - 1, cellPx - 1);
        }
      }
      ctx.stroke();
    }

    // 캐릭터 외곽선 (흰/검 이중선)
    MHS.outlinePath(ctx, this.shape, ox, oy, cellPx);
    ctx.lineWidth = 3 * L.dpr;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.stroke();
    ctx.lineWidth = 1.2 * L.dpr;
    ctx.strokeStyle = this.peek ? '#ffd166' : 'rgba(255,255,255,0.95)';
    ctx.stroke();

    // 붓이 칠해질 자리 미리보기
    const h = this.hover;
    if (h && this.tool !== 'fill' && this.tool !== 'picker') {
      ctx.lineWidth = 1.5 * L.dpr;
      ctx.strokeStyle = '#ffd166';
      for (const [c, r] of this.footprint(h.c, h.r)) {
        if (this.inMask(c, r)) ctx.strokeRect(ox + c * cellPx, oy + r * cellPx, cellPx, cellPx);
      }
    }
  }
}
