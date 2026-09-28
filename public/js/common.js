/* 교사·학생 화면이 함께 쓰는 도구 모음 */
const MHS = (() => {
  let timeOffset = 0;

  function syncTime(state) {
    if (state && state.serverNow) timeOffset = state.serverNow - Date.now();
  }
  const now = () => Date.now() + timeOffset;
  const remaining = (deadline) => (deadline ? Math.max(0, deadline - now()) : 0);
  function fmtTime(ms) {
    const s = Math.ceil(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  /* ---------- 명화 불러오기 & 색 추출 ---------- */

  /** 그림을 "월드 좌표"(긴 변 1600) 크기로 맞춰 픽셀 데이터까지 준비한다 */
  async function loadPainting(url) {
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } catch (e) {
      const res = await fetch(url).catch(() => null);
      let msg = '그림을 불러오지 못했어요.';
      if (res && !res.ok) {
        const body = await res.json().catch(() => null);
        if (body && body.error) msg = body.error;
      }
      throw new Error(msg);
    }
    const long = Shapes.WORLD_LONG_SIDE;
    const k = long / Math.max(img.naturalWidth, img.naturalHeight);
    const w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    return { url, img, canvas, data, w, h };
  }

  /** 월드 좌표의 사각형 영역 평균 색 */
  function sampleAvg(painting, x, y, w, h) {
    const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(painting.w, Math.ceil(x + w)), y1 = Math.min(painting.h, Math.ceil(y + h));
    let r = 0, g = 0, b = 0, n = 0;
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) {
        const i = (yy * painting.w + xx) * 4;
        r += painting.data[i]; g += painting.data[i + 1]; b += painting.data[i + 2]; n++;
      }
    }
    if (!n) return [255, 255, 255];
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  }

  const hexToRgb = (hex) => {
    hex = hex.replace('#', '');
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  };
  const rgbToHex = (rgb) => rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

  function rgbToHsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return [h, s, l];
  }

  function hslToRgb([h, s, l]) {
    if (s === 0) return [l * 255, l * 255, l * 255];
    const hue = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255];
  }

  /** 캐릭터 색이 그 자리 명화와 얼마나 비슷한지 (0~100) */
  function similarity(painting, ch, cell) {
    const s = Shapes.get(ch.shape);
    let total = 0;
    for (let r = 0; r < s.rows; r++) {
      for (let c = 0; c < s.cols; c++) {
        const i = r * s.cols + c;
        if (!s.mask[i]) continue;
        const want = sampleAvg(painting, ch.x + c * cell, ch.y + r * cell, cell, cell);
        const got = hexToRgb(ch.pixels.substr(i * 6, 6));
        const d = Math.hypot(want[0] - got[0], want[1] - got[1], want[2] - got[2]);
        total += Math.max(0, 1 - d / 160);
      }
    }
    return Math.round((total / s.count) * 100);
  }

  /* ---------- 캐릭터 그리기 ---------- */

  const charCache = new Map();

  /** cols x rows 크기의 작은 캔버스에 캐릭터를 그린다 (확대해서 쓰면 테두리가 부드러워진다) */
  function charCanvas(ch) {
    const key = ch.id || ch.shape;
    const hit = charCache.get(key);
    if (hit && hit.pixels === ch.pixels && hit.shape === ch.shape) return hit.canvas;
    const s = Shapes.get(ch.shape);
    const canvas = (hit && hit.canvas) || document.createElement('canvas');
    canvas.width = s.cols;
    canvas.height = s.rows;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(s.cols, s.rows);
    for (let i = 0; i < s.mask.length; i++) {
      if (!s.mask[i]) continue;
      const hex = ch.pixels ? ch.pixels.substr(i * 6, 6) : 'ffffff';
      img.data[i * 4] = parseInt(hex.slice(0, 2), 16);
      img.data[i * 4 + 1] = parseInt(hex.slice(2, 4), 16);
      img.data[i * 4 + 2] = parseInt(hex.slice(4, 6), 16);
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    charCache.set(key, { pixels: ch.pixels, shape: ch.shape, canvas });
    return canvas;
  }

  /** 마스크 경계를 따라 외곽선 경로를 만든다 (x, y, cell 은 그릴 좌표계 기준) */
  function outlinePath(ctx, shapeId, x, y, cell) {
    const s = Shapes.get(shapeId);
    const m = (c, r) => c >= 0 && r >= 0 && c < s.cols && r < s.rows && s.mask[r * s.cols + c];
    ctx.beginPath();
    for (let r = 0; r < s.rows; r++) {
      for (let c = 0; c < s.cols; c++) {
        if (!m(c, r)) continue;
        const px = x + c * cell, py = y + r * cell;
        if (!m(c, r - 1)) { ctx.moveTo(px, py); ctx.lineTo(px + cell, py); }
        if (!m(c, r + 1)) { ctx.moveTo(px, py + cell); ctx.lineTo(px + cell, py + cell); }
        if (!m(c - 1, r)) { ctx.moveTo(px, py); ctx.lineTo(px, py + cell); }
        if (!m(c + 1, r)) { ctx.moveTo(px + cell, py); ctx.lineTo(px + cell, py + cell); }
      }
    }
  }

  /** 흰색 실루엣 미리보기 (모양 고르기 버튼 등) — 긴 변이 px(CSS 픽셀)가 되도록 */
  function shapePreview(shapeId, px, color) {
    const s = Shapes.get(shapeId);
    const k = px / Math.max(s.cols, s.rows);
    const cell = Math.max(1, Math.ceil(k * (window.devicePixelRatio || 1)));
    const canvas = document.createElement('canvas');
    canvas.width = s.cols * cell;
    canvas.height = s.rows * cell;
    canvas.style.width = s.cols * k + 'px';
    canvas.style.height = s.rows * k + 'px';
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = color || '#ffffff';
    for (let i = 0; i < s.mask.length; i++) {
      if (s.mask[i]) ctx.fillRect((i % s.cols) * cell, Math.floor(i / s.cols) * cell, cell, cell);
    }
    return canvas;
  }

  /* ---------- 그림판(필드) 화면 ---------- */

  /** 캔버스를 화면 크기에 맞추고, 그림 전체가 보이도록 하는 변환값을 돌려준다 */
  function fitCanvas(canvas, world) {
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const ch = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    const scale = Math.min(cw / world.w, ch / world.h);
    return {
      scale,
      ox: (cw - world.w * scale) / 2,
      oy: (ch - world.h * scale) / 2,
      dpr,
    };
  }

  function toWorld(view, canvas, ev) {
    const rect = canvas.getBoundingClientRect();
    const sx = (ev.clientX - rect.left) * view.dpr;
    const sy = (ev.clientY - rect.top) * view.dpr;
    return { x: (sx - view.ox) / view.scale, y: (sy - view.oy) / view.scale };
  }

  /**
   * 명화 + 캐릭터들을 그린다.
   * opts.outline: 외곽선을 그릴 캐릭터 id 목록, opts.labels: 이름표를 붙일 id 목록
   */
  function drawScene(canvas, painting, chars, cell, opts) {
    opts = opts || {};
    const view = fitCanvas(canvas, painting);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(view.scale, 0, 0, view.scale, view.ox, view.oy);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(painting.img, 0, 0, painting.w, painting.h);

    for (const c of chars) {
      const s = Shapes.get(c.shape);
      ctx.drawImage(charCanvas(c), c.x, c.y, s.cols * cell, s.rows * cell);
    }

    const lw = 1 / view.scale;
    for (const c of chars) {
      const style = opts.outline && opts.outline[c.id];
      if (!style) continue;
      outlinePath(ctx, c.shape, c.x, c.y, cell);
      ctx.lineWidth = lw * 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.stroke();
      ctx.lineWidth = lw * 2;
      ctx.strokeStyle = style;
      ctx.stroke();
    }

    if (opts.labels) {
      ctx.font = `600 ${13 * view.dpr / view.scale}px "IBM Plex Sans KR", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      for (const c of chars) {
        const label = opts.labels[c.id];
        if (!label) continue;
        const s = Shapes.get(c.shape);
        const tx = c.x + (s.cols * cell) / 2, ty = c.y - 4 * lw;
        const tw = ctx.measureText(label).width + 10 * lw * view.dpr;
        const th = 18 * lw * view.dpr;
        ctx.fillStyle = 'rgba(24,20,16,0.82)';
        ctx.fillRect(tx - tw / 2, ty - th, tw, th);
        ctx.fillStyle = '#fff';
        ctx.fillText(label, tx, ty - 2 * lw * view.dpr);
      }
    }
    return { view, ctx };
  }

  /** 돋보기: 커서(c, 월드 좌표) 주변을 zoom 배로 확대한 원을 그린다 */
  const LENS = { zoom: 2.5, radius: 90 };
  function drawLens(canvas, painting, chars, cell, view, c) {
    if (!c) return;
    const ctx = canvas.getContext('2d');
    const R = LENS.radius * view.dpr;
    const sx = view.ox + c.x * view.scale, sy = view.oy + c.y * view.scale;
    const k = view.scale * LENS.zoom;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath();
    ctx.arc(sx, sy, R, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#111';
    ctx.fillRect(sx - R, sy - R, R * 2, R * 2);
    ctx.setTransform(k, 0, 0, k, sx - c.x * k, sy - c.y * k);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(painting.img, 0, 0, painting.w, painting.h);
    for (const ch of chars) {
      const s = Shapes.get(ch.shape);
      ctx.drawImage(charCanvas(ch), ch.x, ch.y, s.cols * cell, s.rows * cell);
    }
    ctx.restore();
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath();
    ctx.arc(sx, sy, R, 0, Math.PI * 2);
    ctx.lineWidth = 6 * view.dpr;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.stroke();
    ctx.lineWidth = 3 * view.dpr;
    ctx.strokeStyle = '#f2c14e';
    ctx.stroke();
    ctx.restore();
  }

  /* ---------- 기타 ---------- */

  function toast(msg, kind) {
    let box = document.getElementById('toasts');
    if (!box) {
      box = document.createElement('div');
      box.id = 'toasts';
      document.body.appendChild(box);
    }
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.classList.add('out'), 2600);
    setTimeout(() => el.remove(), 3000);
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  /** 받침에 맞는 조사 붙이기: josa('하늘', '이', '가') → '하늘이' */
  function josa(word, withFinal, withoutFinal) {
    const code = String(word).charCodeAt(String(word).length - 1);
    const hasFinal = code >= 0xac00 && code <= 0xd7a3 ? (code - 0xac00) % 28 !== 0 : false;
    return word + (hasFinal ? withFinal : withoutFinal);
  }

  function paintingCaption(p) {
    return p.artist ? `${p.title} — ${p.artist}${p.year ? ', ' + p.year : ''}` : p.title;
  }

  /** 확대(핀치·Ctrl+휠·Ctrl+±) 막기 — 술래가 그림을 확대해서 보지 못하게 */
  function blockZoom() {
    window.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && ['+', '=', '-', '_', '0'].includes(e.key)) e.preventDefault();
    });
    ['gesturestart', 'gesturechange'].forEach((t) => document.addEventListener(t, (e) => e.preventDefault()));
    document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
  }

  return {
    syncTime, now, remaining, fmtTime,
    loadPainting, sampleAvg, hexToRgb, rgbToHex, rgbToHsl, hslToRgb, similarity,
    charCanvas, outlinePath, shapePreview, fitCanvas, toWorld, drawScene, drawLens, LENS,
    toast, esc, josa, paintingCaption, blockZoom,
  };
})();
