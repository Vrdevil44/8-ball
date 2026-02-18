'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  Physics Engine – fixed-timestep simulation
//  Units: mm, mm/s, seconds
// ═══════════════════════════════════════════════════════════════════════════

class Ball {
  constructor(id, x, y) {
    this.id  = id;
    this.x   = x;
    this.y   = y;
    this.vx  = 0;
    this.vy  = 0;
    // Spin around vertical axis (affects cushion rebound): positive = topspin
    this.spinZ = 0;
    this.pocketed = false;
    this.inHand   = false;
  }

  get speed() { return Math.sqrt(this.vx * this.vx + this.vy * this.vy); }
  get info()  { return C.BALLS[this.id]; }
  get isMoving() { return !this.pocketed && this.speed > C.STOP_SPEED; }

  clone() {
    const b = new Ball(this.id, this.x, this.y);
    b.vx = this.vx; b.vy = this.vy; b.spinZ = this.spinZ;
    b.pocketed = this.pocketed; b.inHand = this.inHand;
    return b;
  }
}

// ─── Physics step ────────────────────────────────────────────────────────────

class Physics {
  constructor() {
    this.R  = C.BALL_R;
    this.R2 = 2 * C.BALL_R;
    this.DT = C.SIM_DT;
  }

  // Apply rolling friction to a single ball for one timestep
  _applyFriction(ball) {
    const s = ball.speed;
    if (s < C.STOP_SPEED) { ball.vx = 0; ball.vy = 0; return; }
    const decel = C.MU_ROLL * C.GRAVITY * this.DT;
    const factor = Math.max(0, s - decel) / s;
    ball.vx *= factor;
    ball.vy *= factor;
  }

  // Resolve ball-cushion bounce
  _cushionBounce(ball) {
    const R = this.R;
    const W = C.TABLE_W;
    const H = C.TABLE_H;

    if (ball.x - R < 0) {
      ball.x  = R;
      ball.vx = -ball.vx * C.COR_CUSHION;
      ball.spinZ *= -0.5;
    }
    if (ball.x + R > W) {
      ball.x  = W - R;
      ball.vx = -ball.vx * C.COR_CUSHION;
      ball.spinZ *= -0.5;
    }
    if (ball.y - R < 0) {
      ball.y  = R;
      ball.vy = -ball.vy * C.COR_CUSHION;
      ball.spinZ *= -0.5;
    }
    if (ball.y + R > H) {
      ball.y  = H - R;
      ball.vy = -ball.vy * C.COR_CUSHION;
      ball.spinZ *= -0.5;
    }
  }

  // Resolve ball-ball collision between two balls (equal mass)
  _ballBallCollide(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 1e-6) return;

    const nx = dx / dist;
    const ny = dy / dist;

    // Relative velocity along normal
    const relVn = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
    if (relVn <= 0) return; // Already separating

    // Impulse magnitude (equal mass, COR)
    const j = (1 + C.COR_BALL) * relVn / 2;

    a.vx -= j * nx;
    a.vy -= j * ny;
    b.vx += j * nx;
    b.vy += j * ny;

    // Separate overlapping balls
    const overlap = this.R2 - dist;
    if (overlap > 0) {
      a.x -= nx * overlap * 0.5;
      a.y -= ny * overlap * 0.5;
      b.x += nx * overlap * 0.5;
      b.y += ny * overlap * 0.5;
    }
  }

  // Check if ball entered a pocket
  _checkPockets(ball) {
    for (const p of C.POCKETS) {
      const R = p.type === 'corner' ? C.POCKET_R_CORNER : C.POCKET_R_SIDE;
      const dx = ball.x - p.x;
      const dy = ball.y - p.y;
      if (dx * dx + dy * dy < R * R) {
        ball.pocketed = true;
        ball.vx = 0; ball.vy = 0;
        ball.x = p.x; ball.y = p.y;
        return true;
      }
    }
    return false;
  }

  // ── Single simulation step ──────────────────────────────────────────────
  step(balls) {
    const active = balls.filter(b => !b.pocketed);

    // Move balls
    for (const b of active) {
      if (b.speed < C.STOP_SPEED) { b.vx = 0; b.vy = 0; continue; }
      b.x += b.vx * this.DT;
      b.y += b.vy * this.DT;
      this._applyFriction(b);
      this._cushionBounce(b);
    }

    // Detect ball-ball collisions (O(n²) – fine for 16 balls)
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const a = active[i], b = active[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        if (dx * dx + dy * dy < this.R2 * this.R2) {
          this._ballBallCollide(a, b);
        }
      }
    }

    // Check pockets
    const pocketed = [];
    for (const b of active) {
      if (this._checkPockets(b)) pocketed.push(b.id);
    }

    return pocketed;
  }

  // ── Full shot simulation ─────────────────────────────────────────────────
  // Returns { frames: Array<BallSnapshot[]>, pocketed: Set<id> }
  // frames are sampled every RECORD_EVERY steps so the animator stays light.
  simulate(balls, cueBallId, vx, vy, options = {}) {
    const RECORD_EVERY = options.recordEvery || 4; // record every 4 steps ≈ 12ms
    const clones = balls.map(b => b.clone());
    const cue = clones.find(b => b.id === cueBallId);
    if (!cue) return { frames: [], pocketed: new Set() };

    cue.vx = vx;
    cue.vy = vy;

    const frames    = [];
    const pocketedIds = new Set();
    const maxSteps  = Math.ceil(C.SIM_MAX_TIME / this.DT);
    let   step      = 0;

    while (step < maxSteps) {
      if (step % RECORD_EVERY === 0) {
        frames.push(clones.map(b => ({
          id: b.id, x: b.x, y: b.y, pocketed: b.pocketed,
        })));
      }

      const newPocketed = this.step(clones);
      newPocketed.forEach(id => pocketedIds.add(id));

      // Stop when nothing is moving
      if (!clones.some(b => b.isMoving)) break;
      step++;
    }

    // Final snapshot
    frames.push(clones.map(b => ({
      id: b.id, x: b.x, y: b.y, pocketed: b.pocketed,
    })));

    return { frames, pocketed: pocketedIds, finalBalls: clones };
  }

  // ── Utility: is the path from A to B clear of other balls? ──────────────
  //   excludeIds: ball IDs to ignore (e.g. cue ball and target ball)
  isPathClear(from, to, balls, excludeIds = []) {
    const dir = V.sub(to, from);
    const len = V.len(dir);
    if (len < 1e-6) return true;
    const nd = V.scale(dir, 1 / len);

    for (const b of balls) {
      if (b.pocketed || excludeIds.includes(b.id)) continue;
      // Signed projection along path
      const ap = V.sub(b, from);
      const t  = V.dot(ap, nd);
      if (t < 0 || t > len) continue;
      const perp = Math.abs(ap.x * nd.y - ap.y * nd.x);
      if (perp < this.R2) return false;
    }
    return true;
  }
}

const physics = new Physics();
