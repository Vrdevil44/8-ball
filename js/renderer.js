'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  Renderer – canvas-based AR/virtual table rendering
// ═══════════════════════════════════════════════════════════════════════════

class CoordTransform {
  constructor() {
    this.scale   = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this.canvasW = 800;
    this.canvasH = 400;
  }

  fit(canvasW, canvasH, padding = 40) {
    this.canvasW = canvasW;
    this.canvasH = canvasH;
    const availW = canvasW - padding * 2;
    const availH = canvasH - padding * 2;
    this.scale   = Math.min(availW / C.TABLE_W, availH / C.TABLE_H);
    this.offsetX = (canvasW - C.TABLE_W * this.scale) / 2;
    this.offsetY = (canvasH - C.TABLE_H * this.scale) / 2;
  }

  // Table-mm → canvas pixels
  tx(x) { return x * this.scale + this.offsetX; }
  ty(y) { return y * this.scale + this.offsetY; }
  tp(p) { return { x: this.tx(p.x), y: this.ty(p.y) }; }

  // Canvas pixels → table-mm
  fx(cx) { return (cx - this.offsetX) / this.scale; }
  fy(cy) { return (cy - this.offsetY) / this.scale; }
  fp(cp) { return { x: this.fx(cp.x), y: this.fy(cp.y) }; }

  // Scale a distance
  td(d) { return d * this.scale; }
}

// ─── Renderer class ──────────────────────────────────────────────────────────

class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');
    this.tf     = new CoordTransform();

    // Animation state
    this.animFrames  = null;  // array of frame snapshots from physics
    this.animIndex   = 0;
    this.animating   = false;
    this.animSpeed   = 2;     // frames to advance per render tick

    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.canvas.width  = w * dpr;
    this.canvas.height = h * dpr;
    this.ctx.scale(dpr, dpr);
    this.tf.fit(w, h);
  }

  // ── Master render call ───────────────────────────────────────────────────
  render(state) {
    const ctx = this.ctx;
    const W = this.canvas.width / (window.devicePixelRatio || 1);
    const H = this.canvas.height / (window.devicePixelRatio || 1);

    ctx.clearRect(0, 0, W, H);

    // Background
    ctx.fillStyle = '#0a0e0a';
    ctx.fillRect(0, 0, W, H);

    this._drawTable();
    this._drawPockets();

    if (state) {
      // Overlay: trajectory lines first (under balls)
      if (state.bestShot && state.showAI) {
        this._drawShotOverlay(state.bestShot, state.balls);
      }
      if (state.manualAim) {
        this._drawManualAim(state.manualAim, state.balls);
      }
      this._drawBalls(state.balls, state.selectedBall);
    }
  }

  // ── Table drawing ────────────────────────────────────────────────────────
  _drawTable() {
    const ctx = this.ctx;
    const tf  = this.tf;

    const x = tf.tx(0), y = tf.ty(0);
    const w = tf.td(C.TABLE_W), h = tf.td(C.TABLE_H);
    const railW = tf.td(C.BALL_R * 2.5);

    // Outer rail / frame
    const grad = ctx.createLinearGradient(x - railW, y - railW, x + w + railW, y + h + railW);
    grad.addColorStop(0,   '#4a2a0a');
    grad.addColorStop(0.5, '#7a4a1a');
    grad.addColorStop(1,   '#4a2a0a');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(x - railW, y - railW, w + railW * 2, h + railW * 2, railW * 0.5);
    ctx.fill();

    // Felt
    const feltGrad = ctx.createRadialGradient(
      x + w / 2, y + h / 2, 0,
      x + w / 2, y + h / 2, Math.max(w, h) * 0.7
    );
    feltGrad.addColorStop(0,   '#1a6b2c');
    feltGrad.addColorStop(0.6, '#145521');
    feltGrad.addColorStop(1,   '#0f4019');
    ctx.fillStyle = feltGrad;
    ctx.fillRect(x, y, w, h);

    // Table spots: foot spot and head spot
    this._drawSpot(ctx, tf, C.FOOT_SPOT, '#ffffff33');
    this._drawSpot(ctx, tf, C.HEAD_SPOT, '#ffffff22');

    // Center spot (1/2 mark)
    this._drawSpot(ctx, tf, { x: C.TABLE_W / 2, y: C.TABLE_H / 2 }, '#ffffff22');

    // Head string (break line at 1/4 from head)
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = '#ffffff18';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(tf.tx(C.TABLE_W / 4), tf.ty(0));
    ctx.lineTo(tf.tx(C.TABLE_W / 4), tf.ty(C.TABLE_H));
    ctx.stroke();
    ctx.setLineDash([]);

    // Rail cushion lines (inner edge)
    ctx.strokeStyle = '#2d7a3a';
    ctx.lineWidth = tf.td(C.BALL_R * 0.5);
    ctx.strokeRect(x, y, w, h);
  }

  _drawSpot(ctx, tf, pos, color) {
    ctx.beginPath();
    ctx.arc(tf.tx(pos.x), tf.ty(pos.y), tf.td(C.BALL_R * 0.25), 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  // ── Pocket drawing ───────────────────────────────────────────────────────
  _drawPockets(highlight = -1) {
    const ctx = this.ctx;
    const tf  = this.tf;

    C.POCKETS.forEach((p, i) => {
      const r = tf.td(p.type === 'corner' ? C.POCKET_R_CORNER : C.POCKET_R_SIDE);
      const cx = tf.tx(p.x), cy = tf.ty(p.y);

      // Dark pocket hole
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      const pg = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      pg.addColorStop(0, '#000000');
      pg.addColorStop(1, '#111111');
      ctx.fillStyle = pg;
      ctx.fill();

      // Rim glow
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = i === highlight ? '#00e676' : '#3a2200';
      ctx.lineWidth = 2;
      ctx.stroke();

      if (i === highlight) {
        ctx.beginPath();
        ctx.arc(cx, cy, r * 1.4, 0, Math.PI * 2);
        ctx.strokeStyle = '#00e67640';
        ctx.lineWidth = 3;
        ctx.stroke();
      }
    });
  }

  // ── Ball drawing ─────────────────────────────────────────────────────────
  _drawBalls(balls, selectedId = -1) {
    if (!balls) return;
    // Draw pocketed last (greyed out under table)
    const active   = balls.filter(b => !b.pocketed);
    const pocketed = balls.filter(b => b.pocketed);
    pocketed.forEach(b => this._drawBall(b, false, false));
    active.forEach(b => this._drawBall(b, b.id === selectedId, false));
  }

  _drawBall(ball, selected = false, ghost = false) {
    const ctx = this.ctx;
    const tf  = this.tf;
    const info = C.BALLS[ball.id];
    const cx = tf.tx(ball.x);
    const cy = tf.ty(ball.y);
    const r  = tf.td(C.BALL_R);

    if (ball.pocketed) return; // Don't draw pocketed balls on table

    ctx.save();

    // Shadow
    if (!ghost) {
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur  = r * 0.6;
      ctx.shadowOffsetX = r * 0.15;
      ctx.shadowOffsetY = r * 0.15;
    }

    // Base circle
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);

    if (ghost) {
      ctx.globalAlpha = 0.4;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth   = 2;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
      return;
    }

    if (info.type === 'cue') {
      // White cue ball with slight gradient
      const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, 0, cx, cy, r);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(1, '#d0d0d0');
      ctx.fillStyle = g;
      ctx.fill();
    } else if (info.type === 'eight') {
      ctx.fillStyle = '#111111';
      ctx.fill();
    } else if (info.type === 'solid') {
      // Solid ball
      const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, 0, cx, cy, r);
      g.addColorStop(0, this._lighten(info.css, 50));
      g.addColorStop(1, info.css);
      ctx.fillStyle = g;
      ctx.fill();
    } else if (info.type === 'stripe') {
      // Draw white base then colored stripe
      const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, 0, cx, cy, r);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(1, '#d8d8d8');
      ctx.fillStyle = g;
      ctx.fill();

      // Colored stripe (horizontal band)
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = info.css;
      ctx.fillRect(cx - r, cy - r * 0.42, r * 2, r * 0.84);
      ctx.restore();
    }

    // White dot on 8-ball and colored balls
    if (info.type === 'eight' || info.type === 'solid') {
      ctx.beginPath();
      ctx.arc(cx - r * 0.2, cy - r * 0.2, r * 0.35, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fill();
    }

    // Ball number
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur  = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    const fontSize = Math.max(8, Math.round(r * 0.75));
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';

    if (info.type === 'cue') {
      ctx.fillStyle = '#666666';
      ctx.fillText('CB', cx, cy);
    } else {
      const numX = info.type === 'eight' || info.type === 'solid'
        ? cx - r * 0.2 : cx;
      const numY = info.type === 'eight' || info.type === 'solid'
        ? cy - r * 0.2 : cy;
      ctx.fillStyle = (info.type === 'stripe' || info.type === 'eight') ? '#111' : '#fff';
      ctx.fillText(info.name, numX, numY);
    }

    // Selection ring
    if (selected) {
      ctx.beginPath();
      ctx.arc(cx, cy, r + 4, 0, Math.PI * 2);
      ctx.strokeStyle = '#00e676';
      ctx.lineWidth   = 2.5;
      ctx.stroke();
    }

    ctx.restore();
  }

  _lighten(hex, amount) {
    const num = parseInt(hex.replace('#', ''), 16);
    const r = Math.min(255, (num >> 16) + amount);
    const g = Math.min(255, ((num >> 8) & 0xff) + amount);
    const b = Math.min(255, (num & 0xff) + amount);
    return `rgb(${r},${g},${b})`;
  }

  // ── Shot overlay (AI recommendation) ────────────────────────────────────
  _drawShotOverlay(shot, balls) {
    if (!shot) return;
    const ctx = this.ctx;
    const tf  = this.tf;

    // Highlight target pocket
    const pocketIdx = C.POCKETS.findIndex(p => p.id === shot.pocket.id);
    this._drawPockets(pocketIdx);

    // Object ball → pocket line
    this._drawTrajectoryLine(
      shot.obPath.map(p => tf.tp(p)),
      '#FFD60060', '#FFD600', 2
    );

    // Ghost ball outline
    const ghost = tf.tp(shot.ghost);
    ctx.beginPath();
    ctx.arc(ghost.x, ghost.y, tf.td(C.BALL_R), 0, Math.PI * 2);
    ctx.strokeStyle = '#00e67680';
    ctx.lineWidth   = 2;
    ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Cue ball → ghost ball line
    const cueBall = balls.find(b => b.id === 0);
    if (cueBall) {
      this._drawTrajectoryLine(
        [tf.tp(cueBall), ghost],
        '#00e67650', '#00e676', 2
      );
    }

    // Cue ball path after contact
    if (shot.cbPath && shot.cbPath.length > 1) {
      this._drawTrajectoryLine(
        shot.cbPath.map(p => tf.tp(p)),
        '#4fc3f760', '#4fc3f7', 1.5
      );
    }

    // Aim line extending back past cue ball (aiming aid)
    if (cueBall) {
      const dir = V.norm(V.sub(shot.ghost, cueBall));
      const ext = {
        x: cueBall.x - dir.x * C.TABLE_W * 0.3,
        y: cueBall.y - dir.y * C.TABLE_W * 0.3,
      };
      ctx.beginPath();
      ctx.moveTo(tf.tx(cueBall.x), tf.ty(cueBall.y));
      ctx.lineTo(tf.tx(ext.x), tf.ty(ext.y));
      ctx.strokeStyle = '#ffffff25';
      ctx.lineWidth   = 1;
      ctx.setLineDash([6, 6]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // ── Manual aim overlay ───────────────────────────────────────────────────
  _drawManualAim(aim, balls) {
    if (!aim) return;
    const ctx = this.ctx;
    const tf  = this.tf;

    // Draw aim line from cue to pointer
    this._drawTrajectoryLine(
      [tf.tp(aim.from), tf.tp(aim.to)],
      '#ffffff30', '#ffffff', 2
    );

    // Ghost ball if targeting an object ball
    if (aim.ghost) {
      const ghost = tf.tp(aim.ghost);
      ctx.beginPath();
      ctx.arc(ghost.x, ghost.y, tf.td(C.BALL_R), 0, Math.PI * 2);
      ctx.strokeStyle = '#ffffff80';
      ctx.lineWidth   = 2;
      ctx.setLineDash([5, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Object ball path prediction
      if (aim.obPath) {
        this._drawTrajectoryLine(
          aim.obPath.map(p => tf.tp(p)),
          '#FFD60060', '#FFD600', 1.5
        );
      }
      if (aim.cbPath) {
        this._drawTrajectoryLine(
          aim.cbPath.map(p => tf.tp(p)),
          '#4fc3f760', '#4fc3f7', 1.5
        );
      }
    }
  }

  // ── Trajectory line helper ───────────────────────────────────────────────
  _drawTrajectoryLine(pts, shadowColor, color, width) {
    if (!pts || pts.length < 2) return;
    const ctx = this.ctx;

    // Shadow / glow pass
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.strokeStyle = shadowColor;
    ctx.lineWidth   = width * 4;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    ctx.stroke();

    // Main line
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.strokeStyle = color;
    ctx.lineWidth   = width;
    ctx.stroke();

    // Arrow at the end
    if (pts.length >= 2) {
      const last = pts[pts.length - 1];
      const prev = pts[pts.length - 2];
      const angle = Math.atan2(last.y - prev.y, last.x - prev.x);
      const alen  = Math.max(8, width * 5);
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(
        last.x - alen * Math.cos(angle - 0.4),
        last.y - alen * Math.sin(angle - 0.4)
      );
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(
        last.x - alen * Math.cos(angle + 0.4),
        last.y - alen * Math.sin(angle + 0.4)
      );
      ctx.strokeStyle = color;
      ctx.lineWidth   = width;
      ctx.stroke();
    }
  }

  // ── Animation playback ───────────────────────────────────────────────────
  startAnimation(frames, balls, onComplete) {
    this.animFrames   = frames;
    this.animBalls    = balls;
    this.animIndex    = 0;
    this.animating    = true;
    this._animOnComplete = onComplete;
  }

  tickAnimation(state) {
    if (!this.animating || !this.animFrames) return false;

    const frame = this.animFrames[this.animIndex];
    if (!frame) { this._endAnimation(); return false; }

    // Patch ball positions from frame snapshot
    for (const snap of frame) {
      const ball = state.balls.find(b => b.id === snap.id);
      if (ball) {
        ball.x = snap.x;
        ball.y = snap.y;
        ball.pocketed = snap.pocketed;
      }
    }

    this.animIndex += this.animSpeed;
    if (this.animIndex >= this.animFrames.length) {
      this._endAnimation();
      return false;
    }
    return true;
  }

  _endAnimation() {
    this.animating = false;
    if (this._animOnComplete) this._animOnComplete();
  }

  // ── Utility: hit-test a point against a ball ─────────────────────────────
  hitTestBall(canvasX, canvasY, balls) {
    const tp = this.tf.fp({ x: canvasX, y: canvasY });
    for (const b of balls) {
      if (b.pocketed) continue;
      if (V.dist(b, tp) <= C.BALL_R * 1.5) return b;
    }
    return null;
  }

  // Hit-test against pockets
  hitTestPocket(canvasX, canvasY) {
    const tp = this.tf.fp({ x: canvasX, y: canvasY });
    for (const p of C.POCKETS) {
      const R = p.type === 'corner' ? C.POCKET_R_CORNER * 2 : C.POCKET_R_SIDE * 2;
      if (V.dist(tp, p) <= R) return p;
    }
    return null;
  }

  // Convert a canvas point to table coordinates
  canvasToTable(cx, cy) {
    return this.tf.fp({ x: cx, y: cy });
  }

  // Check if canvas point is within the table bounds
  isOnTable(cx, cy) {
    const tp = this.tf.fp({ x: cx, y: cy });
    return tp.x >= 0 && tp.x <= C.TABLE_W && tp.y >= 0 && tp.y <= C.TABLE_H;
  }

  // ── Camera frame rendering (AR mode) ─────────────────────────────────────
  drawCameraFrame(videoEl) {
    const ctx = this.ctx;
    const W = this.canvas.clientWidth;
    const H = this.canvas.clientHeight;
    ctx.drawImage(videoEl, 0, 0, W, H);
  }
}
