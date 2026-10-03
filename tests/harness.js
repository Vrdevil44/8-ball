'use strict';
// Headless physics + rules checks.  Run: node tests/harness.js
// Loads the browser scripts into one vm context (no DOM needed for these files).
const fs = require('fs'), vm = require('vm'), path = require('path');
const ctx = vm.createContext({ console, Math, Set, Map });
for (const f of ['constants', 'physics', 'gameState']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', f + '.js'), 'utf8')
    .replace(/^'use strict';/, '') + `\n;globalThis.__${f}=1;`, ctx, { filename: f });
}
// top-level const/class aren't properties of the context; re-export them
const get = vm.runInContext('({C, V, Ball, Physics, physics, GameState, GAME_PHASE})', ctx);
const { C, Ball, physics, GameState, GAME_PHASE } = get;

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  FAIL: ' + m); } };
const energy = bs => bs.reduce((e, b) => e + (b.pocketed ? 0 : b.vx * b.vx + b.vy * b.vy), 0);
const R = C.BALL_R;

// ── Physics ────────────────────────────────────────────────────────────────
console.log('physics');
{ // max-power shots in many directions: no ball ever outside the cloth, energy never rises
  const MAX = 500 + 1.0 * 3500;
  let maxStep = 0;
  for (let deg = 0; deg < 360; deg += 7) {
    const balls = GameState.makeRackBalls();
    const cue = balls[0];
    cue.vx = Math.cos(deg * Math.PI / 180) * MAX; cue.vy = Math.sin(deg * Math.PI / 180) * MAX;
    let prev = energy(balls);
    for (let i = 0; i < Math.ceil(C.SIM_MAX_TIME / C.SIM_DT); i++) {
      physics.step(balls);
      for (const b of balls) {
        if (b.pocketed) continue;
        maxStep = Math.max(maxStep, b.speed * C.SIM_DT);
        if (b.x < R - 1e-6 || b.x > C.TABLE_W - R + 1e-6 || b.y < R - 1e-6 || b.y > C.TABLE_H - R + 1e-6)
          ok(false, `ball ${b.id} outside cushions at ${deg}° (${b.x.toFixed(1)},${b.y.toFixed(1)})`);
      }
      const e = energy(balls);
      // Allow a tiny tolerance: positional separation never adds velocity, so any rise is a bug
      if (e > prev * (1 + 1e-9) + 1e-6) { ok(false, `energy rose ${prev}→${e} at ${deg}°, step ${i}`); break; }
      prev = e;
      if (!balls.some(b => b.isMoving)) break;
    }
  }
  ok(maxStep < R, `per-step travel ${maxStep.toFixed(2)}mm must be < ball radius ${R}mm (tunnelling bound)`);
  console.log(`  max per-step travel ${maxStep.toFixed(2)} mm (radius ${R} mm)`);
}
{ // break leaves no overlapping balls
  let worst = 0;
  for (let deg = -20; deg <= 20; deg += 5) {
    const balls = GameState.makeRackBalls();
    balls[0].vx = Math.cos(deg * Math.PI / 180) * 4000; balls[0].vy = Math.sin(deg * Math.PI / 180) * 4000;
    const res = physics.simulate(balls, 0, balls[0].vx, balls[0].vy, { recordEvery: 1000 });
    const fb = res.finalBalls.filter(b => !b.pocketed);
    for (let i = 0; i < fb.length; i++) for (let j = i + 1; j < fb.length; j++) {
      const d = Math.hypot(fb[i].x - fb[j].x, fb[i].y - fb[j].y);
      worst = Math.max(worst, 2 * R - d);
    }
    ok(!fb.some(b => b.isMoving), 'balls still moving after SIM_MAX_TIME');
  }
  ok(worst < 0.5, `final overlap ${worst.toFixed(3)}mm`);
  console.log(`  worst final overlap after break: ${Math.max(0, worst).toFixed(3)} mm`);
}
{ // initial rack itself is overlap-free
  const b = GameState.makeRackBalls(); let w = 0;
  for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) w = Math.max(w, 2 * R - Math.hypot(b[i].x - b[j].x, b[i].y - b[j].y));
  ok(w <= 0, `rack overlaps by ${w}mm`);
}

// ── Rules ──────────────────────────────────────────────────────────────────
console.log('rules');
const P = (...ids) => new Set(ids);
const fresh = () => new GameState();
{ const g = fresh(); g.processShot(P(0), true);
  ok(g.phase === GAME_PHASE.OPEN_TABLE && g.currentPlayer === 2 && g.foul && g.ballInHand, 'scratch on break: open table, turn passes, ball in hand'); }
{ const g = fresh(); g.processShot(P(), false);
  ok(g.phase === GAME_PHASE.OPEN_TABLE && g.currentPlayer === 2 && !g.groups[1], 'dry break: open table, turn passes'); }
{ const g = fresh(); g.processShot(P(3, 12), false);
  ok(g.phase === GAME_PHASE.OPEN_TABLE && g.currentPlayer === 1 && !g.groups[1], 'pot on break: groups NOT assigned, shooter continues'); }
{ const g = fresh(); g.processShot(P(8), false);
  ok(g.reRack && g.phase === GAME_PHASE.BREAK && g.pocketed.size === 0, '8 on break: re-rack'); }
{ const g = fresh(); g.processShot(P(8, 0), true);
  ok(g.reRack && g.phase === GAME_PHASE.BREAK, '8 + scratch on break: re-rack'); }
{ const g = fresh(); g.processShot(P(), false);          // → P2, open
  g.processShot(P(11), false);
  ok(g.groups[2] === 'stripes' && g.groups[1] === 'solids' && g.phase === GAME_PHASE.ASSIGNED_PLAY && g.currentPlayer === 2,
     'first legal pot assigns groups and shooter continues'); }
{ const g = fresh(); g.processShot(P(), false);
  g.processShot(P(5, 12), false);
  ok(g.groups[2] === 'solids', 'two-ball first shot: first-pocketed ball decides group'); }
{ const g = fresh(); g.processShot(P(), false);
  g.processShot(P(4, 0), true);
  ok(!g.groups[2] && g.currentPlayer === 1 && g.foul, 'scratch on open table: no assignment, turn passes'); }
{ const g = fresh(); g.processShot(P(), false); g.processShot(P(2), false);   // P2 solids
  g.processShot(P(8), false);
  ok(g.phase === GAME_PHASE.GAME_OVER && g.winner === 1, '8 pocketed early (assigned play): shooter loses'); }
{ const g = fresh(); g.processShot(P(), false); g.processShot(P(8), false);
  ok(g.phase === GAME_PHASE.GAME_OVER && g.winner === 1, '8 pocketed early (open table): shooter loses'); }
function clearSolids(g) { // P2 holds solids, only the 8 left for them, P2 to shoot
  g.processShot(P(), false); g.processShot(P(1), false);
  g.processShot(P(2, 3, 4, 5, 6, 7), false);
}
{ const g = fresh(); clearSolids(g);
  ok(g.phase === GAME_PHASE.SHOOTING_8 && g.currentPlayer === 2, 'group cleared → SHOOTING_8');
  g.processShot(P(8), false);
  ok(g.phase === GAME_PHASE.GAME_OVER && g.winner === 2, 'legal 8: shooter wins'); }
{ const g = fresh(); clearSolids(g);
  g.processShot(P(8, 0), true);
  ok(g.phase === GAME_PHASE.GAME_OVER && g.winner === 1, '8 on a scratch: shooter loses'); }
{ const g = fresh(); g.processShot(P(), false); g.processShot(P(1), false);   // P2 solids
  g.processShot(P(2, 3, 4, 5, 6, 7, 8), false);                                // clears and sinks 8 same shot
  ok(g.phase === GAME_PHASE.GAME_OVER && g.winner === 1, '8 sunk same shot as last group ball: loss'); }
{ const g = fresh(); clearSolids(g);
  g.processShot(P(), false);
  ok(g.phase === GAME_PHASE.ASSIGNED_PLAY && g.currentPlayer === 1, 'phase follows the shooter (opponent not on the 8)'); }
{ const g = fresh(); g.processShot(P(), false); g.processShot(P(1), false);   // P2 solids
  g.processShot(P(9), false); // sank opponent's ball only
  ok(g.currentPlayer === 1, 'sinking only opponent ball passes the turn'); }

console.log(fails ? `\n${fails} FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
