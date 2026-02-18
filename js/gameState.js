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
    this.ballInHandAfterScratch = false;
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

  // Called after a shot completes. newPocketed = Set<id> pocketed this shot.
  // scratchCueBall = true if cue ball was pocketed.
  processShot(newPocketed, scratchCueBall = false) {
    this.foul = false;
    this.ballInHand = false;
    let madeOwnBall = false;
    let madeCueBall = scratchCueBall;

    if (scratchCueBall) {
      this.foul = true;
      this.ballInHand = true;
    }

    for (const id of newPocketed) {
      if (id === 0) continue; // cue ball handled separately
      this.pocketed.add(id);
    }

    // Phase transitions
    if (this.phase === GAME_PHASE.BREAK) {
      const solPocketed = this.solidIds.filter(id => newPocketed.has(id));
      const strPocketed = this.stripeIds.filter(id => newPocketed.has(id));

      if (newPocketed.has(8)) {
        // 8 on break = re-rack or spot 8 (house rules: re-rack)
        this.message = '8-ball on break! Re-rack.';
        this.reset();
        return;
      }

      if (!scratchCueBall && (solPocketed.length + strPocketed.length) > 0) {
        // Assign groups based on more balls pocketed (or first pocketed if tie)
        if (solPocketed.length > strPocketed.length) {
          this.groups[1] = 'solids'; this.groups[2] = 'stripes';
        } else if (strPocketed.length > solPocketed.length) {
          this.groups[1] = 'stripes'; this.groups[2] = 'solids';
        } else {
          // Tie – keep open table for now
          this.phase = GAME_PHASE.OPEN_TABLE;
          this.message = `Table open. Player ${this.currentPlayer}'s turn.`;
          return;
        }
        this.phase = GAME_PHASE.ASSIGNED_PLAY;
        madeOwnBall = true;
      } else {
        this.phase = GAME_PHASE.OPEN_TABLE;
      }
    }

    if (this.phase === GAME_PHASE.OPEN_TABLE) {
      const solPocketed = this.solidIds.filter(id => newPocketed.has(id));
      const strPocketed = this.stripeIds.filter(id => newPocketed.has(id));

      if (!scratchCueBall && (solPocketed.length + strPocketed.length) > 0) {
        if (solPocketed.length >= strPocketed.length) {
          this.groups[this.currentPlayer] = 'solids';
          this.groups[this.oppositePlayer] = 'stripes';
        } else {
          this.groups[this.currentPlayer] = 'stripes';
          this.groups[this.oppositePlayer] = 'solids';
        }
        this.phase = GAME_PHASE.ASSIGNED_PLAY;
        madeOwnBall = true;
      }
    }

    if (this.phase === GAME_PHASE.ASSIGNED_PLAY) {
      const myGroup = this.groupIds(this.currentGroup);
      const myPocketed = myGroup.filter(id => newPocketed.has(id));
      madeOwnBall = myPocketed.length > 0 && !scratchCueBall;

      // Check if player cleared their group
      const remaining = myGroup.filter(id => !this.pocketed.has(id));
      if (remaining.length === 0) {
        this.phase = GAME_PHASE.SHOOTING_8;
      }
    }

    if (this.phase === GAME_PHASE.SHOOTING_8) {
      if (newPocketed.has(8)) {
        if (scratchCueBall || this.foul) {
          this.winner = this.oppositePlayer;
          this.phase = GAME_PHASE.GAME_OVER;
          this.message = `Player ${this.oppositePlayer} wins! (Foul on 8-ball)`;
          return;
        }
        this.winner = this.currentPlayer;
        this.phase = GAME_PHASE.GAME_OVER;
        this.message = `Player ${this.currentPlayer} wins! 🎱`;
        return;
      }
      // Shot missed 8-ball or pocketed wrong ball – foul
      const wrongBalls = this.groupIds(this.currentGroup).filter(id => newPocketed.has(id));
      if (wrongBalls.length > 0 && !scratchCueBall) {
        // Accidentally pocketed own group ball when should shoot 8
        this.foul = true;
        this.ballInHand = true;
      }
    }

    // Determine if turn continues or switches
    if (madeOwnBall && !this.foul) {
      this.message = `Player ${this.currentPlayer} continues!`;
    } else {
      this._switchTurn();
    }

    this._buildMessage();
  }

  _switchTurn() {
    this.currentPlayer = this.oppositePlayer;
  }

  _buildMessage() {
    if (this.phase === GAME_PHASE.GAME_OVER) return;
    const p = this.currentPlayer;
    const g = this.groups[p];
    const foulStr = this.foul ? ' (Foul – ball in hand) ' : '';
    if (this.phase === GAME_PHASE.BREAK) {
      this.message = `Player ${p}: Break!`;
    } else if (this.phase === GAME_PHASE.OPEN_TABLE) {
      this.message = `Player ${p}: Table open – sink any ball${foulStr}`;
    } else if (this.phase === GAME_PHASE.ASSIGNED_PLAY) {
      this.message = `Player ${p}: Shoot ${g}${foulStr}`;
    } else if (this.phase === GAME_PHASE.SHOOTING_8) {
      this.message = `Player ${p}: Shoot the 8-ball!${foulStr}`;
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
