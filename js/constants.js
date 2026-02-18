'use strict';

// ─── Physical constants ─────────────────────────────────────────────────────
// All distances in millimetres, speeds in mm/s, times in seconds.
const C = {
  // 9-foot table playing surface
  TABLE_W: 2540,   // mm (100 in)
  TABLE_H: 1270,   // mm  (50 in)
  BALL_R:  28.575, // mm (1.125 in radius)

  // Friction / restitution (from Dr. Dave Alciatore / Mathavan 2010)
  MU_ROLL:    0.010,
  MU_SLIDE:   0.200,
  MU_CUSHION: 0.140,
  COR_BALL:   0.930,
  COR_CUSHION:0.750,
  GRAVITY:    9810,   // mm/s²

  // Pocket acceptance radius (centre of ball to centre of pocket)
  POCKET_R_CORNER: 68,
  POCKET_R_SIDE:   75,

  // Simulation
  SIM_DT:       0.003,   // seconds per physics step (3 ms)
  SIM_MAX_TIME: 12,      // seconds before forcing stop
  STOP_SPEED:   2,       // mm/s – treat as stationary below this

  // Pocket positions [x, y] in table-mm coords
  POCKETS: [
    { id: 0, x: 0,    y: 0,    type: 'corner', label: 'Top-Left' },
    { id: 1, x: 1270, y: 0,    type: 'side',   label: 'Top-Mid' },
    { id: 2, x: 2540, y: 0,    type: 'corner', label: 'Top-Right' },
    { id: 3, x: 0,    y: 1270, type: 'corner', label: 'Bot-Left' },
    { id: 4, x: 1270, y: 1270, type: 'side',   label: 'Bot-Mid' },
    { id: 5, x: 2540, y: 1270, type: 'corner', label: 'Bot-Right' },
  ],

  // Ball catalogue
  BALLS: [
    { id: 0,  name: 'Cue',  type: 'cue',   css: '#F0F0F0', r: 238, g: 238, b: 238 },
    { id: 1,  name: '1',    type: 'solid', css: '#FDD835', r: 253, g: 216, b: 53  },
    { id: 2,  name: '2',    type: 'solid', css: '#1565C0', r: 21,  g: 101, b: 192 },
    { id: 3,  name: '3',    type: 'solid', css: '#C62828', r: 198, g: 40,  b: 40  },
    { id: 4,  name: '4',    type: 'solid', css: '#6A1B9A', r: 106, g: 27,  b: 154 },
    { id: 5,  name: '5',    type: 'solid', css: '#E65100', r: 230, g: 81,  b: 0   },
    { id: 6,  name: '6',    type: 'solid', css: '#2E7D32', r: 46,  g: 125, b: 50  },
    { id: 7,  name: '7',    type: 'solid', css: '#880E4F', r: 136, g: 14,  b: 79  },
    { id: 8,  name: '8',    type: 'eight', css: '#111111', r: 17,  g: 17,  b: 17  },
    { id: 9,  name: '9',    type: 'stripe',css: '#FDD835', r: 253, g: 216, b: 53  },
    { id: 10, name: '10',   type: 'stripe',css: '#1565C0', r: 21,  g: 101, b: 192 },
    { id: 11, name: '11',   type: 'stripe',css: '#C62828', r: 198, g: 40,  b: 40  },
    { id: 12, name: '12',   type: 'stripe',css: '#6A1B9A', r: 106, g: 27,  b: 154 },
    { id: 13, name: '13',   type: 'stripe',css: '#E65100', r: 230, g: 81,  b: 0   },
    { id: 14, name: '14',   type: 'stripe',css: '#2E7D32', r: 46,  g: 125, b: 50  },
    { id: 15, name: '15',   type: 'stripe',css: '#880E4F', r: 136, g: 14,  b: 79  },
  ],

  // 8-ball standard break rack – foot spot at x=1905 (3/4 of table length)
  FOOT_SPOT: { x: 1905, y: 635 },
  HEAD_SPOT: { x: 635,  y: 635 },

  // Cut angle difficulty thresholds (degrees)
  DIFFICULTY: [
    { max: 15,  label: 'Easy',      color: '#00E676' },
    { max: 30,  label: 'Medium',    color: '#FFEA00' },
    { max: 45,  label: 'Hard',      color: '#FF9100' },
    { max: 180, label: 'Very Hard', color: '#FF1744' },
  ],
};

// ─── Math helpers ───────────────────────────────────────────────────────────
const V = {
  add:  (a, b)    => ({ x: a.x + b.x, y: a.y + b.y }),
  sub:  (a, b)    => ({ x: a.x - b.x, y: a.y - b.y }),
  scale:(a, s)    => ({ x: a.x * s,   y: a.y * s   }),
  dot:  (a, b)    => a.x * b.x + a.y * b.y,
  len:  (a)       => Math.sqrt(a.x * a.x + a.y * a.y),
  len2: (a)       => a.x * a.x + a.y * a.y,
  norm: (a)       => { const l = V.len(a); return l < 1e-9 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l }; },
  dist: (a, b)    => V.len(V.sub(b, a)),
  dist2:(a, b)    => V.len2(V.sub(b, a)),
  perp: (a)       => ({ x: -a.y, y: a.x }),
  angle:(a)       => Math.atan2(a.y, a.x),
  fromAngle: (t)  => ({ x: Math.cos(t), y: Math.sin(t) }),
  lerp: (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }),

  // Angle between two vectors in radians [0, PI]
  angleBetween(a, b) {
    const d = V.dot(V.norm(a), V.norm(b));
    return Math.acos(Math.max(-1, Math.min(1, d)));
  },

  // Perpendicular distance from point P to infinite line (A, dir)
  pointLinePerp(p, lineA, lineDir) {
    const ap = V.sub(p, lineA);
    const d  = V.len(lineDir);
    if (d < 1e-9) return V.len(ap);
    return Math.abs(ap.x * lineDir.y - ap.y * lineDir.x) / d;
  },

  // Closest point on segment [A,B] to P, returns { t, pt, dist }
  closestOnSegment(p, a, b) {
    const ab = V.sub(b, a);
    const ap = V.sub(p, a);
    const len2 = V.len2(ab);
    const t = len2 < 1e-9 ? 0 : Math.max(0, Math.min(1, V.dot(ap, ab) / len2));
    const pt = V.add(a, V.scale(ab, t));
    return { t, pt, dist: V.dist(p, pt) };
  },

  toDeg: r => r * 180 / Math.PI,
  toRad: d => d * Math.PI / 180,
};
