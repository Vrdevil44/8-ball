'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  ARRenderer – renders shot overlays directly onto the live camera view
//  using the established homography (table-mm → screen-px transform).
//
//  In AR/FPV mode the entire canvas is the camera feed; all overlays are
//  positioned by projecting table-mm coordinates through H.
//  In Demo mode the classic virtual table is drawn on a dark background.
// ═══════════════════════════════════════════════════════════════════════════

class ARRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');
    this.dpr    = window.devicePixelRatio || 1;

    // Virtual-table coordinate transform (demo mode)
    this._tf    = new CoordTransform();

    // Animation state
    this.animating  = false;
    this.animFrames = null;
    this.animIndex  = 0;
    this.animSpeed  = 2;
    this._animOnComplete = null;

    this._resize();
    window.addEventListener('resize', () => this._resize());
    window.addEventListener('orientationchange', () => setTimeout(() => this._resize(), 200));
  }

  get W() { return this.canvas.width  / this.dpr; }
  get H() { return this.canvas.height / this.dpr; }

  _resize() {
    this.dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth  || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width  = w * this.dpr;
    this.canvas.height = h * this.dpr;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this._tf.fit(w, h);
  }

  // ── Master render ────────────────────────────────────────────────────────
  render(state) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.W, this.H);

    if (state.mode === 'demo') {
      this._renderDemo(state);
    } else {
      this._renderAR(state);
    }
  }

  // ── Demo mode (virtual table) ─────────────────────────────────────────────
  _renderDemo(state) {
    const ctx = this.ctx;
    ctx.fillStyle = '#0a0e0a';
    ctx.fillRect(0, 0, this.W, this.H);

    this._drawVirtualTable();
    this._drawVirtualPockets();

    if (state.bestShot && state.showAI && !this.animating) {
      this._drawShotOverlayVirtual(state.bestShot, state.balls);
    }
    if (state.manualAim) this._drawManualAimVirtual(state.manualAim, state.balls);
    this._drawVirtualBalls(state.balls, state.selectedBall);
    this._drawCalibrationCorners(state);
  }

  // ── AR mode (camera background + overlays) ────────────────────────────────
  _renderAR(state) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.W, this.H);

    // AR overlays drawn using homography
    const arSession = state.arSession;
    const proj      = arSession?.calibrated
      ? (tx, ty) => arSession.tableToScreen(tx, ty)
      : null;

    if (proj) {
      // Draw table outline
      this._drawARTableOutline(arSession);

      // Shot recommendations
      if (state.bestShot && state.showAI && !this.animating) {
        this._drawShotOverlayAR(state.bestShot, state.balls, proj);
      }

      // Manual aim
      if (state.manualAim) this._drawManualAimAR(state.manualAim, state.balls, proj);

      // Balls (projected circles on detected positions)
      this._drawARBalls(state.balls, state.selectedBall, proj);

      // Pocket highlights
      this._drawARPockets(proj, state.bestShot);

    } else if (arSession?.state === 'tapping') {
      // Show calibration guidance
      this._drawCalibrationGuide(arSession);
    }

    // Stick overlay (always in screen space)
    if (state.stickResult) {
      this._drawStickOverlay(state.stickResult, proj);
    }

    // Calibration corner markers
    this._drawCalibrationCorners(state);
  }

  // ── AR: table outline from calibration corners ────────────────────────────
  _drawARTableOutline(arSession) {
    if (!arSession.corners || arSession.corners.length < 4) return;
    const ctx = this.ctx;
    const corners = arSession.corners;

    ctx.save();
    ctx.strokeStyle = 'rgba(0, 230, 118, 0.5)';
    ctx.lineWidth   = 2;
    ctx.setLineDash([8, 6]);
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  // ── AR: project and draw balls ────────────────────────────────────────────
  _drawARBalls(balls, selectedId, proj) {
    if (!balls) return;
    for (const ball of balls) {
      if (ball.pocketed) continue;
      const sp = proj(ball.x, ball.y);
      this._drawARBall(ball, sp.x, sp.y, ball.id === selectedId, 14);
    }
  }

  _drawARBall(ball, cx, cy, selected, r) {
    const ctx  = this.ctx;
    const info = C.BALLS[ball.id];
    ctx.save();

    // Outer ring glow
    ctx.beginPath();
    ctx.arc(cx, cy, r + 3, 0, Math.PI * 2);
    ctx.strokeStyle = selected ? '#00e676' : 'rgba(255,255,255,0.3)';
    ctx.lineWidth   = selected ? 3 : 1;
    ctx.stroke();

    // Ball fill
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = info.css;
    ctx.fill();

    // Stripe white band
    if (info.type === 'stripe') {
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(cx - r, cy - r * 0.4, r * 2, r * 0.8);
      ctx.restore();
    }

    // Ball number
    const fontSize = Math.max(7, r * 0.75);
    ctx.font = `bold ${fontSize}px -apple-system, sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle    = (info.type === 'cue' || info.type === 'stripe') ? '#111' : '#fff';
    ctx.fillText(info.name, cx, cy);
    ctx.restore();
  }

  // ── AR: pocket highlights ─────────────────────────────────────────────────
  _drawARPockets(proj, bestShot) {
    const ctx = this.ctx;
    C.POCKETS.forEach((p) => {
      const sp    = proj(p.x, p.y);
      const isTarget = bestShot && bestShot.pocket.id === p.id;
      const r = isTarget ? 14 : 8;

      ctx.beginPath();
      ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
      ctx.fillStyle = isTarget ? 'rgba(0,230,118,0.35)' : 'rgba(0,0,0,0.4)';
      ctx.fill();
      ctx.strokeStyle = isTarget ? '#00e676' : 'rgba(255,255,255,0.2)';
      ctx.lineWidth   = isTarget ? 2.5 : 1;
      ctx.stroke();

      if (isTarget) {
        // Pulsing ring
        const pulse = 0.6 + 0.4 * Math.sin(Date.now() / 300);
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, r * 1.8 * pulse, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(0,230,118,${0.4 * pulse})`;
        ctx.lineWidth   = 2;
        ctx.stroke();

        // Pocket label
        ctx.font = 'bold 11px -apple-system, sans-serif';
        ctx.fillStyle = '#00e676';
        ctx.textAlign = 'center';
        ctx.fillText(p.label, sp.x, sp.y - r - 6);
      }
    });
  }

  // ── AR: shot overlay (trajectory lines projected onto table) ─────────────
  _drawShotOverlayAR(shot, balls, proj) {
    if (!shot) return;
    const ctx = this.ctx;

    // Object ball → pocket trajectory
    const obPts = shot.obPath.map(p => proj(p.x, p.y));
    this._drawGlowLine(obPts, '#FFD600', 2.5, 0.7);

    // Cue ball → ghost ball approach line
    const cue = balls.find(b => b.id === 0);
    if (cue) {
      const cueSP   = proj(cue.x, cue.y);
      const ghostSP = proj(shot.ghost.x, shot.ghost.y);
      this._drawGlowLine([cueSP, ghostSP], '#00e676', 2, 0.7);

      // Ghost ball
      this._drawGhostBall(ghostSP.x, ghostSP.y, 14);

      // Cue ball post-contact path
      if (shot.cbPath && shot.cbPath.length > 1) {
        const cbPts = shot.cbPath.map(p => proj(p.x, p.y));
        this._drawGlowLine(cbPts, '#4fc3f7', 1.5, 0.6, [6, 5]);
      }

      // Back extension of aim line (aiming guide)
      const dir = V.norm(V.sub(shot.ghost, cue));
      const ext = {
        x: cue.x - dir.x * C.TABLE_W * 0.4,
        y: cue.y - dir.y * C.TABLE_W * 0.4,
      };
      const extSP = proj(ext.x, ext.y);
      ctx.beginPath();
      ctx.moveTo(cueSP.x, cueSP.y);
      ctx.lineTo(extSP.x, extSP.y);
      ctx.strokeStyle = 'rgba(255,255,255,0.2)';
      ctx.lineWidth   = 1;
      ctx.setLineDash([8, 8]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Power label next to ghost ball
    const sp = proj(shot.ghost.x, shot.ghost.y);
    if (shot.suggestedPower) {
      ctx.save();
      ctx.font = 'bold 12px -apple-system, sans-serif';
      ctx.fillStyle = '#00e676';
      ctx.textAlign = 'left';
      ctx.shadowColor = '#000';
      ctx.shadowBlur  = 6;
      ctx.fillText(`⚡ ${Math.round(shot.suggestedPower * 100)}%`, sp.x + 18, sp.y - 8);
      ctx.restore();
    }
  }

  // ── AR: manual aim overlay ────────────────────────────────────────────────
  _drawManualAimAR(aim, balls, proj) {
    if (!aim) return;
    this._drawGlowLine([aim.from, aim.to], '#ffffff', 2, 0.5, [5, 5]);
    if (aim.ghost) {
      const g = proj(aim.ghost.x, aim.ghost.y);
      this._drawGhostBall(g.x, g.y, 14);
      if (aim.obPath) this._drawGlowLine(aim.obPath.map(p => proj(p.x, p.y)), '#FFD600', 2, 0.6);
      if (aim.cbPath) this._drawGlowLine(aim.cbPath.map(p => proj(p.x, p.y)), '#4fc3f7', 1.5, 0.5, [5, 5]);
    }
  }

  // ── AR: cue stick overlay ─────────────────────────────────────────────────
  _drawStickOverlay(stick, proj) {
    if (!stick || stick.confidence < 0.2) return;
    const ctx = this.ctx;
    const alpha = Math.min(1, stick.confidence);

    // Draw detected stick line
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = '#FFD600';
    ctx.lineWidth   = 4;
    ctx.shadowColor = '#FFD600';
    ctx.shadowBlur  = 12;
    ctx.beginPath();
    ctx.moveTo(stick.line.x1, stick.line.y1);
    ctx.lineTo(stick.line.x2, stick.line.y2);
    ctx.stroke();

    // Tip marker
    ctx.beginPath();
    ctx.arc(stick.tipPt.x, stick.tipPt.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#FFD600';
    ctx.fill();

    // Aim ray from tip forward (in screen space)
    const rayEnd = {
      x: stick.tipPt.x + stick.aimDir.x * 200,
      y: stick.tipPt.y + stick.aimDir.y * 200,
    };
    ctx.strokeStyle = 'rgba(255, 214, 0, 0.5)';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(stick.tipPt.x, stick.tipPt.y);
    ctx.lineTo(rayEnd.x, rayEnd.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // If aim hits table, show target marker
    if (stick.aimPt && proj) {
      const ap = proj(stick.aimPt.x, stick.aimPt.y);
      ctx.beginPath();
      ctx.arc(ap.x, ap.y, 10, 0, Math.PI * 2);
      ctx.strokeStyle = '#FFD600';
      ctx.lineWidth   = 2;
      ctx.stroke();
      // Crosshair
      ctx.beginPath();
      ctx.moveTo(ap.x - 12, ap.y); ctx.lineTo(ap.x + 12, ap.y);
      ctx.moveTo(ap.x, ap.y - 12); ctx.lineTo(ap.x, ap.y + 12);
      ctx.strokeStyle = 'rgba(255,214,0,0.8)';
      ctx.lineWidth   = 1.5;
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
    ctx.shadowBlur  = 0;
    ctx.restore();
  }

  // ── Calibration guide ─────────────────────────────────────────────────────
  _drawCalibrationGuide(arSession) {
    const ctx  = this.ctx;
    const n    = arSession.corners.length;
    const names = arSession.cornerNames;

    // Tapped corners
    for (let i = 0; i < n; i++) {
      const p = arSession.corners[i];
      ctx.save();
      ctx.beginPath();
      ctx.arc(p.x, p.y, 14, 0, Math.PI * 2);
      ctx.fillStyle   = 'rgba(0, 230, 118, 0.8)';
      ctx.fill();
      ctx.font = 'bold 10px -apple-system, sans-serif';
      ctx.fillStyle = '#000';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(i + 1, p.x, p.y);
      ctx.restore();
    }

    // Next corner label
    if (n < 4) {
      const label = `Tap corner ${n + 1}: ${names[n]}`;
      ctx.save();
      ctx.font = 'bold 16px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#00e676';
      ctx.shadowColor = '#000';
      ctx.shadowBlur  = 10;
      ctx.fillText(label, this.W / 2, this.H / 2);
      ctx.restore();
    }
  }

  // ── Calibration corner markers ────────────────────────────────────────────
  _drawCalibrationCorners(state) {
    const arSession = state.arSession;
    if (!arSession || arSession.state !== 'tapping') return;
    this._drawCalibrationGuide(arSession);
  }

  // ── Ghost ball ────────────────────────────────────────────────────────────
  _drawGhostBall(cx, cy, r) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 0.65;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth   = 2;
    ctx.setLineDash([4, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  // ── Glow line ─────────────────────────────────────────────────────────────
  _drawGlowLine(pts, color, width, alpha = 1, dash = []) {
    if (!pts || pts.length < 2) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.setLineDash(dash);
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';

    // Glow pass
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.strokeStyle = color;
    ctx.lineWidth   = width * 5;
    ctx.globalAlpha = alpha * 0.25;
    ctx.stroke();

    // Main line
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.strokeStyle = color;
    ctx.lineWidth   = width;
    ctx.globalAlpha = alpha;
    ctx.stroke();

    // Arrow at end
    if (pts.length >= 2) {
      const last  = pts[pts.length - 1];
      const prev  = pts[pts.length - 2];
      const angle = Math.atan2(last.y - prev.y, last.x - prev.x);
      const al    = Math.max(9, width * 5);
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(last.x - al * Math.cos(angle - 0.45), last.y - al * Math.sin(angle - 0.45));
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(last.x - al * Math.cos(angle + 0.45), last.y - al * Math.sin(angle + 0.45));
      ctx.strokeStyle = color;
      ctx.lineWidth   = width;
      ctx.globalAlpha = alpha;
      ctx.stroke();
    }

    ctx.setLineDash([]);
    ctx.restore();
  }

  // ── Virtual table (demo mode) ─────────────────────────────────────────────
  _drawVirtualTable() {
    const ctx = this.ctx, tf = this._tf;
    const x = tf.tx(0), y = tf.ty(0);
    const w = tf.td(C.TABLE_W), h = tf.td(C.TABLE_H);
    const railW = tf.td(C.BALL_R * 2.5);

    const g = ctx.createLinearGradient(x - railW, y - railW, x + w + railW, y + h + railW);
    g.addColorStop(0, '#4a2a0a'); g.addColorStop(0.5, '#7a4a1a'); g.addColorStop(1, '#4a2a0a');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.roundRect(x - railW, y - railW, w + railW * 2, h + railW * 2, railW * 0.5);
    ctx.fill();

    const fg = ctx.createRadialGradient(x + w/2, y + h/2, 0, x + w/2, y + h/2, Math.max(w, h) * 0.7);
    fg.addColorStop(0, '#1a6b2c'); fg.addColorStop(0.6, '#145521'); fg.addColorStop(1, '#0f4019');
    ctx.fillStyle = fg;
    ctx.fillRect(x, y, w, h);

    this._drawSpot(C.FOOT_SPOT, '#ffffff33');
    this._drawSpot(C.HEAD_SPOT, '#ffffff22');
    this._drawSpot({ x: C.TABLE_W / 2, y: C.TABLE_H / 2 }, '#ffffff22');

    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = '#ffffff18'; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(tf.tx(C.TABLE_W / 4), tf.ty(0));
    ctx.lineTo(tf.tx(C.TABLE_W / 4), tf.ty(C.TABLE_H));
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = '#2d7a3a'; ctx.lineWidth = tf.td(C.BALL_R * 0.5);
    ctx.strokeRect(x, y, w, h);
  }

  _drawSpot(pos, color) {
    const ctx = this.ctx, tf = this._tf;
    ctx.beginPath();
    ctx.arc(tf.tx(pos.x), tf.ty(pos.y), tf.td(C.BALL_R * 0.25), 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
  }

  _drawVirtualPockets(highlight = -1) {
    const ctx = this.ctx, tf = this._tf;
    C.POCKETS.forEach((p, i) => {
      const r  = tf.td(p.type === 'corner' ? C.POCKET_R_CORNER : C.POCKET_R_SIDE);
      const cx = tf.tx(p.x), cy = tf.ty(p.y);
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
      const pg = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      pg.addColorStop(0, '#000000'); pg.addColorStop(1, '#111111');
      ctx.fillStyle = pg; ctx.fill();
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = i === highlight ? '#00e676' : '#3a2200';
      ctx.lineWidth = 2; ctx.stroke();
    });
  }

  _drawVirtualBalls(balls, selectedId = -1) {
    if (!balls) return;
    balls.filter(b => !b.pocketed).forEach(b => this._drawVirtualBall(b, b.id === selectedId));
  }

  _drawVirtualBall(ball, selected = false) {
    const ctx = this.ctx, tf = this._tf;
    if (ball.pocketed) return;
    const info = C.BALLS[ball.id];
    const cx = tf.tx(ball.x), cy = tf.ty(ball.y), r = tf.td(C.BALL_R);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = r * 0.6;
    ctx.shadowOffsetX = r * 0.15; ctx.shadowOffsetY = r * 0.15;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);

    if (info.type === 'cue') {
      const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, 0, cx, cy, r);
      g.addColorStop(0, '#ffffff'); g.addColorStop(1, '#d0d0d0');
      ctx.fillStyle = g;
    } else if (info.type === 'eight') {
      ctx.fillStyle = '#111111';
    } else if (info.type === 'solid') {
      const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, 0, cx, cy, r);
      g.addColorStop(0, this._lighten(info.css, 50)); g.addColorStop(1, info.css);
      ctx.fillStyle = g;
    } else {
      const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, 0, cx, cy, r);
      g.addColorStop(0, '#ffffff'); g.addColorStop(1, '#d8d8d8');
      ctx.fillStyle = g;
    }
    ctx.fill();

    if (info.type === 'stripe') {
      ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.clip();
      ctx.fillStyle = info.css; ctx.fillRect(cx - r, cy - r * 0.42, r * 2, r * 0.84);
      ctx.restore();
    }

    if (info.type === 'eight' || info.type === 'solid') {
      ctx.beginPath(); ctx.arc(cx - r * 0.2, cy - r * 0.2, r * 0.35, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.fill();
    }

    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
    const fontSize = Math.max(8, Math.round(r * 0.75));
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const numX = (info.type === 'eight' || info.type === 'solid') ? cx - r * 0.2 : cx;
    const numY = (info.type === 'eight' || info.type === 'solid') ? cy - r * 0.2 : cy;
    ctx.fillStyle = (info.type === 'stripe' || info.type === 'eight') ? '#111' : '#fff';
    ctx.fillText(info.type === 'cue' ? 'CB' : info.name, numX, numY);

    if (selected) {
      ctx.beginPath(); ctx.arc(cx, cy, r + 4, 0, Math.PI * 2);
      ctx.strokeStyle = '#00e676'; ctx.lineWidth = 2.5; ctx.stroke();
    }
    ctx.restore();
  }

  _lighten(hex, amount) {
    const n = parseInt(hex.replace('#', ''), 16);
    const r = Math.min(255, (n >> 16) + amount);
    const g = Math.min(255, ((n >> 8) & 0xff) + amount);
    const b = Math.min(255, (n & 0xff) + amount);
    return `rgb(${r},${g},${b})`;
  }

  _drawShotOverlayVirtual(shot, balls) {
    if (!shot) return;
    const tf = this._tf;
    const pIdx = C.POCKETS.findIndex(p => p.id === shot.pocket.id);
    this._drawVirtualPockets(pIdx);
    this._drawGlowLine(shot.obPath.map(p => tf.tp(p)), '#FFD600', 2);
    const ghost = tf.tp(shot.ghost);
    this._drawGhostBall(ghost.x, ghost.y, tf.td(C.BALL_R));
    const cue = balls.find(b => b.id === 0);
    if (cue) {
      this._drawGlowLine([tf.tp(cue), ghost], '#00e676', 2);
      if (shot.cbPath?.length > 1) this._drawGlowLine(shot.cbPath.map(p => tf.tp(p)), '#4fc3f7', 1.5, 1, [6, 5]);
    }
  }

  _drawManualAimVirtual(aim, balls) {
    if (!aim) return;
    const tf = this._tf;
    this._drawGlowLine([tf.tp(aim.from), tf.tp(aim.to)], '#ffffff', 2, 0.5, [5, 5]);
    if (aim.ghost) {
      const g = tf.tp(aim.ghost);
      this._drawGhostBall(g.x, g.y, tf.td(C.BALL_R));
      if (aim.obPath) this._drawGlowLine(aim.obPath.map(p => tf.tp(p)), '#FFD600', 2);
      if (aim.cbPath) this._drawGlowLine(aim.cbPath.map(p => tf.tp(p)), '#4fc3f7', 1.5, 0.7, [5, 5]);
    }
  }

  // ── Animation ─────────────────────────────────────────────────────────────
  startAnimation(frames, balls, onComplete) {
    this.animFrames = frames; this.animIndex = 0;
    this.animating  = true;
    this._animOnComplete = onComplete;
  }

  tickAnimation(state) {
    if (!this.animating || !this.animFrames) return false;
    const frame = this.animFrames[this.animIndex];
    if (!frame) { this._endAnimation(); return false; }
    for (const snap of frame) {
      const ball = state.balls.find(b => b.id === snap.id);
      if (ball) { ball.x = snap.x; ball.y = snap.y; ball.pocketed = snap.pocketed; }
    }
    this.animIndex += this.animSpeed;
    if (this.animIndex >= this.animFrames.length) { this._endAnimation(); return false; }
    return true;
  }

  _endAnimation() {
    this.animating = false;
    if (this._animOnComplete) this._animOnComplete();
  }

  // ── Hit testing (demo mode) ───────────────────────────────────────────────
  hitTestBall(canvasX, canvasY, balls) {
    const tp = this._tf.fp({ x: canvasX, y: canvasY });
    for (const b of balls) {
      if (b.pocketed) continue;
      if (V.dist(b, tp) <= C.BALL_R * 1.5) return b;
    }
    return null;
  }

  hitTestPocket(canvasX, canvasY) {
    const tp = this._tf.fp({ x: canvasX, y: canvasY });
    for (const p of C.POCKETS) {
      const R = (p.type === 'corner' ? C.POCKET_R_CORNER : C.POCKET_R_SIDE) * 2;
      if (V.dist(tp, p) <= R) return p;
    }
    return null;
  }

  canvasToTable(cx, cy) { return this._tf.fp({ x: cx, y: cy }); }
}

// ── CoordTransform (keep for demo mode) ──────────────────────────────────────
class CoordTransform {
  constructor() { this.scale = 1; this.offsetX = 0; this.offsetY = 0; }
  fit(canvasW, canvasH, padding = 40) {
    const availW = canvasW - padding * 2, availH = canvasH - padding * 2;
    this.scale   = Math.min(availW / C.TABLE_W, availH / C.TABLE_H);
    this.offsetX = (canvasW - C.TABLE_W * this.scale) / 2;
    this.offsetY = (canvasH - C.TABLE_H * this.scale) / 2;
  }
  tx(x) { return x * this.scale + this.offsetX; }
  ty(y) { return y * this.scale + this.offsetY; }
  tp(p) { return { x: this.tx(p.x), y: this.ty(p.y) }; }
  fx(cx) { return (cx - this.offsetX) / this.scale; }
  fy(cy) { return (cy - this.offsetY) / this.scale; }
  fp(cp) { return { x: this.fx(cp.x), y: this.fy(cp.y) }; }
  td(d)  { return d * this.scale; }
}
