'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  8-Ball Game State Machine
// ═══════════════════════════════════════════════════════════════════════════

const GAME_PHASE = {
  BREAK:         'BREAK',
  OPEN_TABLE:    'OPEN_TABLE',
  ASSIGNED_PLAY: 'ASSIGNED_PLAY',
  SHOOTING_8:    'SHOOTING_8',
  GAME_OVER:     'GAME_OVER',
};

class GameState {
  constructor() {
    this.reset();
  }

  reset() {
    this.phase       = GAME_PHASE.BREAK;
    this.currentPlayer = 1;   // 1 or 2
    this.groups      = { 1: null, 2: null }; // 'solids' | 'stripes' | null
    this.pocketed    = new Set();            // set of ball ids pocketed
    this.shotHistory = [];
    this.winner      = null;
    this.message     = 'Break! Player 1 shoots.';
    this.foul        = false;
    this.ballInHand  = false;
    this.reRack      = false;                // set when 8 sunk on the break
  }

  get oppositePlayer() { return this.currentPlayer === 1 ? 2 : 1; }

  get currentGroup() { return this.groups[this.currentPlayer]; }

  // All balls (1-7 solids, 9-15 stripes) except 8 and cue
  get solidIds()  { return [1, 2, 3, 4, 5, 6, 7]; }
  get stripeIds() { return [9, 10, 11, 12, 13, 14, 15]; }

  groupIds(group) {
    if (group === 'solids')  return this.solidIds;
    if (group === 'stripes') return this.stripeIds;
    return [];
  }

  remainingForPlayer(player) {
    const g = this.groups[player];
    if (!g) return this.phase === GAME_PHASE.SHOOTING_8 ? [8] : [...this.solidIds, ...this.stripeIds];
    const ids = this.groupIds(g).filter(id => !this.pocketed.has(id));
    return ids.length === 0 ? [8] : ids;
  }

  // Legal target balls for the current player
  legalTargets() {
    if (this.phase === GAME_PHASE.BREAK || this.phase === GAME_PHASE.OPEN_TABLE) {
      // May hit any ball (besides cue) – any solid/stripe pocket assigns group
      return [...this.solidIds, ...this.stripeIds].filter(id => !this.pocketed.has(id));
    }
    if (this.phase === GAME_PHASE.ASSIGNED_PLAY) {
      const rem = this.groupIds(this.currentGroup).filter(id => !this.pocketed.has(id));
      return rem; // must hit own group first
    }
    if (this.phase === GAME_PHASE.SHOOTING_8) {
      return [8];
    }
    return [];
  }

  // Called after a shot completes. newPocketed = Set<id> in pocketing order.
  // scratchCueBall = true if cue ball was pocketed.
  //
  // Rules (bar-style, no call-shot): table is open after the break; the first
  // legal pot after the break assigns groups; an 8-ball pocketed before the
  // shooter has cleared their group, or on a scratch, loses; 8 on the break
  // re-racks (see this.reRack). First-contact fouls are NOT detected because
  // the simulator only reports pocketed balls.
  processShot(newPocketed, scratchCueBall = false) {
    this.foul = scratchCueBall;
    this.ballInHand = scratchCueBall;
    this.reRack = false;

    const priorPhase = this.phase;
    const shooter = this.currentPlayer;

    for (const id of newPocketed) {
      if (id !== 0) this.pocketed.add(id);
    }

    // ── 8-ball pocketed ──
    if (newPocketed.has(8)) {
      if (priorPhase === GAME_PHASE.BREAK) {
        this.reset();
        this.reRack = true;
        this.message = '8-ball on the break! Re-rack, Player 1 breaks.';
        return;
      }
      const legal = priorPhase === GAME_PHASE.SHOOTING_8 && !scratchCueBall;
      this.winner = legal ? shooter : this.oppositePlayer;
      this.phase = GAME_PHASE.GAME_OVER;
      this.message = legal
        ? `Player ${shooter} wins! 🎱`
        : `Player ${this.winner} wins! (` +
          (scratchCueBall ? 'scratch on the 8-ball)' : '8-ball pocketed early)');
      return;
    }

    // ── Group assignment: first legal pot after the break ──
    let madeOwnBall = false;
    if (priorPhase === GAME_PHASE.BREAK) {
      this.phase = GAME_PHASE.OPEN_TABLE;
      madeOwnBall = !scratchCueBall && [...newPocketed].some(id => id !== 0);
    } else if (priorPhase === GAME_PHASE.OPEN_TABLE) {
      const first = [...newPocketed].find(id => this.solidIds.includes(id) || this.stripeIds.includes(id));
      if (!scratchCueBall && first !== undefined) {
        const g = this.solidIds.includes(first) ? 'solids' : 'stripes';
        this.groups[shooter] = g;
        this.groups[this.oppositePlayer] = g === 'solids' ? 'stripes' : 'solids';
        madeOwnBall = true;
      }
    } else if (this.groups[shooter]) {
      const mine = this.groupIds(this.groups[shooter]);
      madeOwnBall = !scratchCueBall && mine.some(id => newPocketed.has(id));
    }

    if (!(madeOwnBall && !this.foul)) this._switchTurn();
    this._refreshPhase();
    this._buildMessage(madeOwnBall && !this.foul);
  }

  // Phase for whoever shoots next: groups cleared → shooting the 8.
  _refreshPhase() {
    if (this.phase === GAME_PHASE.GAME_OVER || this.phase === GAME_PHASE.BREAK) return;
    const g = this.currentGroup;
    if (!g) { this.phase = GAME_PHASE.OPEN_TABLE; return; }
    const left = this.groupIds(g).filter(id => !this.pocketed.has(id));
    this.phase = left.length === 0 ? GAME_PHASE.SHOOTING_8 : GAME_PHASE.ASSIGNED_PLAY;
  }

  _switchTurn() {
    this.currentPlayer = this.oppositePlayer;
  }

  _buildMessage(continues = false) {
    if (this.phase === GAME_PHASE.GAME_OVER) return;
    const p = this.currentPlayer;
    const g = this.groups[p];
    const foulStr = this.foul ? ' (Foul – ball in hand)' : '';
    const again = continues ? ' continues.' : ':';
    if (this.phase === GAME_PHASE.BREAK) {
      this.message = `Player ${p}: Break!`;
    } else if (this.phase === GAME_PHASE.OPEN_TABLE) {
      this.message = `Player ${p}${again} Table open – sink any ball${foulStr}`;
    } else if (this.phase === GAME_PHASE.ASSIGNED_PLAY) {
      this.message = `Player ${p}${again} Shoot ${g}${foulStr}`;
    } else if (this.phase === GAME_PHASE.SHOOTING_8) {
      this.message = `Player ${p}${again} Shoot the 8-ball!${foulStr}`;
    }
  }

  // ── Standard 8-ball break rack ──────────────────────────────────────────
  static makeRackBalls() {
    const R  = C.BALL_R;
    const fs = C.FOOT_SPOT;
    const dx = R * 2 * Math.cos(V.toRad(0));   // horizontal spacing
    const dy = R * 2 * Math.sin(V.toRad(60));  // vertical spacing (60°)

    // Rack template: 5 rows, 15 balls
    // Row positions relative to foot spot apex
    // Standard 8-ball rack: 8 in center, corners mixed
    const rackOrder = [
      /* row 0 */ [1],
      /* row 1 */ [10, 2],
      /* row 2 */ [9, 8, 3],
      /* row 3 */ [6, 14, 4, 11],
      /* row 4 */ [13, 7, 15, 5, 12],
    ];

    const balls = [];

    // Cue ball
    balls.push(new Ball(0, C.HEAD_SPOT.x, C.HEAD_SPOT.y));

    rackOrder.forEach((row, ri) => {
      row.forEach((ballId, ci) => {
        const x = fs.x + ri * dy * 1.01;  // slight padding to avoid overlap
        const y = fs.y + (ci - (row.length - 1) / 2) * R * 2.02;
        balls.push(new Ball(ballId, x, y));
      });
    });

    return balls;
  }

  // ── Random layout for demo ──────────────────────────────────────────────
  static makeRandomBalls(count = 7) {
    const R    = C.BALL_R;
    const margin = R * 3;
    const W = C.TABLE_W - margin * 2;
    const H = C.TABLE_H - margin * 2;
    const balls = [];
    const used = new Set();

    // Cue ball
    balls.push(new Ball(0, C.HEAD_SPOT.x, C.HEAD_SPOT.y));
    used.add(0);

    // Random set of object balls
    const ids = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15];
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    const chosen = ids.slice(0, count);

    const maxTries = 500;
    for (const id of chosen) {
      let placed = false;
      for (let t = 0; t < maxTries; t++) {
        const x = margin + Math.random() * W;
        const y = margin + Math.random() * H;
        let ok = true;
        for (const b of balls) {
          if (V.dist(b, { x, y }) < C.BALL_R * 2.2) { ok = false; break; }
        }
        if (ok) {
          balls.push(new Ball(id, x, y));
          placed = true;
          break;
        }
      }
      if (!placed) {
        // fallback: just place somewhere
        balls.push(new Ball(id, C.TABLE_W / 2 + Math.random() * 200 - 100,
                                C.TABLE_H / 2 + Math.random() * 200 - 100));
      }
    }
    return balls;
  }
}
