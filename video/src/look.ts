// Visual tokens lifted from the app itself (static/index.html :root and city.js colors), so the film wears the
// product's own skin: deep navy ground, glassy panels, green-up / red-down, gold for undervalued, teal for flow.
export const C = {
  bg: '#0b0e14',
  panel: 'rgba(20,25,36,0.93)',
  line: '#2a3140',
  fg: '#dde3ee',
  mut: '#8b93a5',
  up: '#22c55e',
  down: '#ef4444',
  acc: '#3b82f6',
  gold: '#f5b301',
  cyan: '#22d3ee',
  teal: '#5eead4',
};

export const FONT = {
  sans: '"Noto Sans", "Noto Sans CJK TC", system-ui, sans-serif',
  zh: '"Noto Sans CJK TC", "Noto Sans", system-ui, sans-serif',
};

// Motion voice: "professional / fintech" preset — ~21f entrances, soft ease-out, no bounce.
const bezier = (x1: number, y1: number, x2: number, y2: number) => {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const e = sx(t) - x;
      if (Math.abs(e) < 1e-6) break;
      t -= e / (dx(t) || 1e-6);
    }
    return sy(t);
  };
};

export const EASE = {
  out: bezier(0.22, 1, 0.36, 1),     // quint-out: blur-slide words, callouts
  enter: bezier(0, 0, 0.2, 1),       // fintech entrance
  smooth: bezier(0.65, 0, 0.35, 1),
  exit: bezier(0.7, 0, 0.84, 0),
};

export const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
export const ramp = (frame: number, start: number, dur: number, ease: (t: number) => number = EASE.out) =>
  ease(clamp01((frame - start) / Math.max(1e-6, dur)));
