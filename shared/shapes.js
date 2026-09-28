/*
 * 캐릭터 모양 정의 (서버/클라이언트 공용)
 *
 * 각 모양은 cols x rows 격자 위에 원·타원·캡슐·다각형 같은 도형을 겹쳐서 정의한다.
 * 격자의 각 칸(cell)이 학생이 색칠하는 한 "픽셀"이 되고,
 * 칸의 중심이 도형 안에 들어오면 캐릭터의 일부(mask = 1)가 된다.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Shapes = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const circle = (cx, cy, r) => ({ t: 'circle', cx, cy, r });
  const ellipse = (cx, cy, rx, ry) => ({ t: 'ellipse', cx, cy, rx, ry });
  const capsule = (x1, y1, x2, y2, r) => ({ t: 'capsule', x1, y1, x2, y2, r });
  const poly = (pts) => ({ t: 'poly', pts });

  const DEFS = {
    person: {
      name: '사람', cols: 20, rows: 34,
      parts: [
        circle(10, 5.5, 4.3),
        capsule(10, 9, 10, 11, 1.6),
        capsule(10, 13.5, 10, 19.5, 4.6),
        capsule(5.8, 12, 2.8, 21.5, 1.6),
        capsule(14.2, 12, 17.2, 21.5, 1.6),
        capsule(8, 22, 7.5, 31.6, 2.1),
        capsule(12, 22, 12.5, 31.6, 2.1),
      ],
    },
    cat: {
      name: '고양이', cols: 22, rows: 28,
      parts: [
        ellipse(11, 19.5, 7.2, 8),
        circle(11, 8.5, 5.6),
        poly([[5.6, 6.5], [6.2, 0.6], [10, 3.6]]),
        poly([[16.4, 6.5], [15.8, 0.6], [12, 3.6]]),
        capsule(16.5, 26, 20.8, 17, 1.4),
      ],
    },
    dog: {
      name: '강아지', cols: 32, rows: 24,
      parts: [
        capsule(9, 12.5, 21, 12.5, 4.6),
        circle(24.5, 7.5, 4.6),
        ellipse(28.8, 9.2, 2.8, 2.1),
        capsule(21.8, 5.2, 20.6, 11, 1.6),
        capsule(7.5, 15, 7.5, 22.8, 1.8),
        capsule(11.5, 15, 11.5, 22.8, 1.8),
        capsule(18.5, 15, 18.5, 22.8, 1.8),
        capsule(22.5, 15, 22.5, 22.8, 1.8),
        capsule(5, 10.5, 1.6, 4.5, 1.3),
      ],
    },
    rabbit: {
      name: '토끼', cols: 22, rows: 32,
      parts: [
        ellipse(11, 23.5, 7.4, 7.4),
        circle(11, 13.2, 5),
        capsule(8.6, 9.5, 7.4, 1.8, 1.9),
        capsule(13.4, 9.5, 14.6, 1.8, 1.9),
        circle(18.2, 26, 2.2),
        ellipse(7.5, 30.4, 3.6, 1.4),
        ellipse(14.5, 30.4, 3.6, 1.4),
      ],
    },
    bird: {
      name: '새', cols: 28, rows: 22,
      parts: [
        ellipse(13, 12.5, 8.2, 6),
        circle(20.5, 7.5, 4.2),
        poly([[24, 6.3], [27.8, 8], [24, 9.8]]),
        poly([[6.2, 10], [0.3, 6.5], [0.8, 13.5], [6.2, 15]]),
        capsule(11.5, 17.5, 10.8, 21.5, 0.8),
        capsule(15, 17.5, 15.6, 21.5, 0.8),
      ],
    },
    fish: {
      name: '물고기', cols: 30, rows: 18,
      parts: [
        ellipse(13, 9.5, 10, 6.3),
        poly([[21, 9.5], [29.6, 2.2], [29.6, 16.8]]),
        poly([[9, 4], [14.5, 0.4], [17, 4.2]]),
      ],
    },
  };

  const ORDER = ['person', 'cat', 'dog', 'rabbit', 'bird', 'fish'];

  // 캐릭터 크기 설정: 격자 한 칸이 명화(긴 변 = 1600) 위에서 차지하는 크기
  const CELL_SIZES = { small: 2, medium: 2.6, large: 3.2, xlarge: 4.2 };
  const WORLD_LONG_SIDE = 1600;

  function insidePart(p, x, y) {
    switch (p.t) {
      case 'circle':
        return (x - p.cx) ** 2 + (y - p.cy) ** 2 <= p.r * p.r;
      case 'ellipse':
        return ((x - p.cx) / p.rx) ** 2 + ((y - p.cy) / p.ry) ** 2 <= 1;
      case 'capsule': {
        const dx = p.x2 - p.x1, dy = p.y2 - p.y1;
        const len2 = dx * dx + dy * dy;
        let t = len2 ? ((x - p.x1) * dx + (y - p.y1) * dy) / len2 : 0;
        t = Math.max(0, Math.min(1, t));
        const px = p.x1 + t * dx, py = p.y1 + t * dy;
        return (x - px) ** 2 + (y - py) ** 2 <= p.r * p.r;
      }
      case 'poly': {
        let inside = false;
        const pts = p.pts;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const [xi, yi] = pts[i], [xj, yj] = pts[j];
          if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
      }
      default:
        return false;
    }
  }

  const cache = {};

  /** 모양 정보 + 마스크(Uint8Array, 1 = 캐릭터 영역) */
  function get(id) {
    if (!DEFS[id]) id = 'person';
    if (cache[id]) return cache[id];
    const def = DEFS[id];
    const mask = new Uint8Array(def.cols * def.rows);
    let count = 0;
    for (let r = 0; r < def.rows; r++) {
      for (let c = 0; c < def.cols; c++) {
        const x = c + 0.5, y = r + 0.5;
        if (def.parts.some((p) => insidePart(p, x, y))) {
          mask[r * def.cols + c] = 1;
          count++;
        }
      }
    }
    cache[id] = { id, name: def.name, cols: def.cols, rows: def.rows, mask, count };
    return cache[id];
  }

  /** 캐릭터 기준 좌표(칸 단위)가 캐릭터 영역에 닿는지 — tol 칸만큼 여유를 준다 */
  function hit(id, lx, ly, tol) {
    const s = get(id);
    tol = tol || 0;
    const offsets = tol ? [-tol, 0, tol] : [0];
    for (const dy of offsets) {
      for (const dx of offsets) {
        const c = Math.floor(lx + dx), r = Math.floor(ly + dy);
        if (c >= 0 && r >= 0 && c < s.cols && r < s.rows && s.mask[r * s.cols + c]) return true;
      }
    }
    return false;
  }

  /** 모든 칸을 흰색으로 채운 픽셀 문자열 (칸마다 6자리 hex) */
  function blankPixels(id) {
    const s = get(id);
    return 'ffffff'.repeat(s.cols * s.rows);
  }

  function isValidPixels(id, str) {
    const s = get(id);
    return typeof str === 'string' && str.length === s.cols * s.rows * 6 && /^[0-9a-f]*$/.test(str);
  }

  /** 흰색이 아닌 칸의 비율 (색칠 진행도) */
  function paintedRatio(id, str) {
    const s = get(id);
    if (!str) return 0;
    let painted = 0;
    for (let i = 0; i < s.mask.length; i++) {
      if (s.mask[i] && str.substr(i * 6, 6) !== 'ffffff') painted++;
    }
    return s.count ? painted / s.count : 0;
  }

  return { DEFS, ORDER, CELL_SIZES, WORLD_LONG_SIDE, get, hit, blankPixels, isValidPixels, paintedRatio };
});
