'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  Shot Engine – ghost ball aiming, trajectory prediction, shot scoring AI
// ═══════════════════════════════════════════════════════════════════════════

class ShotEngine {
  constructor() {
    this.R  = C.BALL_R;
    this.R2 = 2 * C.BALL_R;
  }

  // ── Ghost-ball aiming ────────────────────────────────────────────────────
  // Returns the position the cue ball must reach to send objBall into pocket.
  ghostBall(objBall, pocket) {
    const dir = V.norm(V.sub(pocket, objBall));
    return {
      x: objBall.x - dir.x * this.R2,
      y: objBall.y - dir.y * this.R2,
    };
  }

  // Cut angle in degrees (0 = straight in, 90 = impossible thin cut)
  cutAngle(cueBall, ghostPos, objBall) {
    const cueToGhost = V.norm(V.sub(ghostPos, cueBall));
    const ghostToObj = V.norm(V.sub(objBall, ghostPos));
    const dot = V.dot(cueToGhost, ghostToObj);
    return V.toDeg(Math.acos(Math.max(-1, Math.min(1, dot))));
  }

  // ── Cue-ball path after contact (simplified 30° rule + stun/draw) ───────
  // Returns an array of {x,y} waypoints for the predicted CB path.
  cueBallPath(cueBall, ghostPos, objBall, spinType = 'natural') {
    const dir = V.norm(V.sub(ghostPos, cueBall));          // CB → ghost
    const objDir = V.norm(V.sub(objBall, ghostPos));       // contact normal
    // Tangent line (perpendicular to line of centers, 90° from objDir)
    const tangent = { x: -objDir.y, y: objDir.x };

    // Choose tangent sign so it's "forward" relative to cue direction
    const forward = V.dot(dir, tangent) < 0
      ? { x: -tangent.x, y: -tangent.y }
      : tangent;

    let postDir;
    if (spinType === 'stun') {
      postDir = forward; // pure 90° tangent
    } else if (spinType === 'draw') {
      // Reverse along approach direction
      postDir = V.norm({ x: -dir.x, y: -dir.y });
    } else {
      // Natural / follow – 30° rule from tangent
      const deg30 = V.toRad(30);
      const cos30 = Math.cos(deg30), sin30 = Math.sin(deg30);
      // Rotate forward by -30° toward approach direction
      const fd = forward;
      postDir = V.norm({
        x: fd.x * cos30 + fd.y * sin30,
        y: -fd.x * sin30 + fd.y * cos30,
      });
    }

    // Trace path until hits cushion, up to 2 bounces
    const paths = [];
    let pos = { x: ghostPos.x, y: ghostPos.y };
    const speed = 1200; // typical mm travel distance post-contact

    paths.push({ ...pos });
    for (let bounce = 0; bounce < 2; bounce++) {
      const end = {
        x: pos.x + postDir.x * speed,
        y: pos.y + postDir.y * speed,
      };
      const clipped = this._clipToBounds(pos, end);
      paths.push({ ...clipped.pt });

      if (!clipped.hitWall) break;
      // Reflect direction
      if (clipped.wall === 'x') postDir = { x: -postDir.x, y: postDir.y };
      else                      postDir = { x: postDir.x,  y: -postDir.y };
      pos = clipped.pt;
    }
    return paths;
  }

  // ── Object-ball trajectory (straight line to pocket, checking cushion) ──
  objBallPath(objBall, pocket) {
    const pts = [{ x: objBall.x, y: objBall.y }];
    const dir = V.norm(V.sub(pocket, objBall));
    const dist = V.dist(objBall, pocket);
    // Extend slightly past pocket
    pts.push({
      x: objBall.x + dir.x * dist * 1.05,
      y: objBall.y + dir.y * dist * 1.05,
    });
    return pts;
  }

  // Clip a ray from A toward B against the table boundaries.
  _clipToBounds(a, b) {
    const R = this.R;
    const xMin = R, xMax = C.TABLE_W - R;
    const yMin = R, yMax = C.TABLE_H - R;

    let tx = Infinity, ty = Infinity, wall = null;
    const dx = b.x - a.x, dy = b.y - a.y;

    if (dx > 0) tx = (xMax - a.x) / dx;
    if (dx < 0) tx = (xMin - a.x) / dx;
    if (dy > 0) ty = (yMax - a.y) / dy;
    if (dy < 0) ty = (yMin - a.y) / dy;

    const t = Math.min(tx, ty);

    if (t >= 1 || t < 0) {
      return { pt: { ...b }, hitWall: false };
    }

    wall = (tx <= ty) ? 'x' : 'y';
    const pt = { x: a.x + dx * t, y: a.y + dy * t };
    return { pt, hitWall: true, wall };
  }

  // ── Shot scoring ─────────────────────────────────────────────────────────
  // Returns a score 0–100 for shooting cueBall → objBall → pocket.
  scoreShot(cueBall, objBall, pocket, allBalls, pocketedSet) {
    const ghostPos = this.ghostBall(objBall, pocket);
    const cut = this.cutAngle(cueBall, ghostPos, objBall);

    // (1) Pocketability – based on cut angle and distance
    if (cut > 70) return 0; // near-impossible cut
    const cutScore = Math.max(0, 1 - cut / 70);

    const distCB_GB = V.dist(cueBall, ghostPos);
    const distOB_P  = V.dist(objBall, pocket);
    // Longer shots are harder
    const distPenalty = Math.max(0, 1 - (distCB_GB + distOB_P) / (C.TABLE_W * 1.5));

    const pocketability = cutScore * 0.6 + distPenalty * 0.4;

    // (2) Path clearance
    const excludes = [cueBall.id, objBall.id];
    const cbClear = physics.isPathClear(cueBall, ghostPos, allBalls, excludes);
    const obClear = physics.isPathClear(objBall, pocket, allBalls, [objBall.id]);
    if (!cbClear || !obClear) return 0;

    // (3) Scratch risk: does cue ball path threaten a pocket?
    const cbPost = this.cueBallPath(cueBall, ghostPos, objBall, 'natural');
    const scratchRisk = this._scratchRisk(ghostPos, cbPost, allBalls);

    // (4) Effective pocket opening angle
    const pocketType = pocket.type;
    const openingR = pocketType === 'corner' ? C.POCKET_R_CORNER : C.POCKET_R_SIDE;
    const angleMargin = Math.atan2(openingR, distOB_P);
    const openingScore = Math.min(1, angleMargin / V.toRad(5));

    // Weighted score
    const raw = pocketability * 0.50
              + openingScore  * 0.20
              + (1 - scratchRisk) * 0.15
              + distPenalty   * 0.15;

    return Math.round(raw * 100);
  }

  _scratchRisk(from, pathPts, allBalls) {
    if (pathPts.length < 2) return 0;
    // Check if cue-ball path lands near any pocket
    for (const p of C.POCKETS) {
      for (let i = 0; i < pathPts.length - 1; i++) {
        const closest = V.closestOnSegment(p, pathPts[i], pathPts[i + 1]);
        if (closest.dist < C.POCKET_R_CORNER * 2.5) return 0.8;
      }
    }
    return 0;
  }

  // ── Best shot finder ─────────────────────────────────────────────────────
  // Returns sorted array of candidate shots for the current player.
  findBestShots(balls, gameState) {
    const cueBall = balls.find(b => b.id === 0);
    if (!cueBall || cueBall.pocketed) return [];

    const targets = gameState.legalTargets()
      .map(id => balls.find(b => b.id === id))
      .filter(b => b && !b.pocketed);

    const candidates = [];

    for (const obj of targets) {
      for (const pocket of C.POCKETS) {
        const ghost = this.ghostBall(obj, pocket);
        const cut   = this.cutAngle(cueBall, ghost, obj);
        if (cut > 75) continue;

        const score = this.scoreShot(cueBall, obj, pocket, balls, gameState.pocketed);
        if (score <= 0) continue;

        const difficulty = this._difficultyLabel(cut);

        candidates.push({
          objBall:  obj,
          pocket,
          ghost,
          cut,
          score,
          difficulty,
          cbPath: this.cueBallPath(cueBall, ghost, obj, 'natural'),
          obPath: this.objBallPath(obj, pocket),
        });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates;
  }

  _difficultyLabel(cut) {
    for (const d of C.DIFFICULTY) {
      if (cut <= d.max) return d;
    }
    return C.DIFFICULTY[C.DIFFICULTY.length - 1];
  }

  // ── Compute initial cue velocity from aim direction + power ─────────────
  //  power: 0–1 multiplier → maps to ~500–4000 mm/s
  aimToVelocity(cueBall, targetPos, power = 0.5) {
    const dir   = V.norm(V.sub(targetPos, cueBall));
    const speed = 500 + power * 3500;
    return { vx: dir.x * speed, vy: dir.y * speed };
  }

  // Given a recommended shot, compute the required cue velocity
  shotVelocity(cueBall, shotData, power = 0.5) {
    return this.aimToVelocity(cueBall, shotData.ghost, power);
  }
}

const shotEngine = new ShotEngine();
