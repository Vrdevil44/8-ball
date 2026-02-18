'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  TrainingDB – stores shot attempts and outcomes in IndexedDB.
//
//  Schema: shots store
//  {
//    id:          auto-increment
//    timestamp:   Date.now()
//    preShotBalls: [{id, x, y}]            // table-mm positions before shot
//    shot: {
//      ballId, pocket, power,              // 0-1
//      difficulty, score, cutAngle,
//      suggestedPower                       // computed AI power
//    }
//    outcome: {
//      pocketed:    [ballIds],
//      cuePocketed: bool,
//      success:     bool                   // intended ball went in
//      duration:    number                 // ms from shot to stop
//    }
//    postShotBalls: [{id, x, y}]           // table-mm positions after shot
//    stickData: {                          // cue stick info if available
//      detected: bool,
//      confidence: number,
//      aimDiff: number                     // angular diff between AI and stick aim
//    }
//  }
// ═══════════════════════════════════════════════════════════════════════════

class TrainingDB {
  constructor() {
    this.DB_NAME    = '8ball_training';
    this.DB_VERSION = 2;
    this.STORE      = 'shots';
    this.db         = null;
    this._ready     = false;
    this._queue     = [];
  }

  // ── Open / upgrade ────────────────────────────────────────────────────────
  async open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.DB_NAME, this.DB_VERSION);

      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(this.STORE)) {
          const store = db.createObjectStore(this.STORE, { keyPath: 'id', autoIncrement: true });
          store.createIndex('timestamp', 'timestamp', { unique: false });
          store.createIndex('success',   'outcome.success', { unique: false });
        }
      };

      req.onsuccess = (e) => {
        this.db     = e.target.result;
        this._ready = true;
        this._flushQueue();
        resolve(true);
      };

      req.onerror = () => {
        console.warn('TrainingDB: IndexedDB unavailable');
        resolve(false);
      };
    });
  }

  // ── Record a shot attempt (before outcome is known) ──────────────────────
  // Returns a pending record ID.
  async startShot(preShotBalls, shot, stickData = null) {
    const record = {
      timestamp:    Date.now(),
      preShotBalls: preShotBalls.filter(b => !b.pocketed).map(b => ({ id: b.id, x: b.x, y: b.y })),
      shot: {
        ballId:          shot.objBall?.id ?? -1,
        pocket:          shot.pocket?.id  ?? -1,
        power:           shot.power  ?? 0,
        difficulty:      shot.difficulty?.label ?? 'unknown',
        score:           shot.score ?? 0,
        cutAngle:        shot.cut ?? 0,
        suggestedPower:  shot.suggestedPower ?? 0,
      },
      stickData: stickData ? {
        detected:   stickData.detected,
        confidence: stickData.confidence ?? 0,
        aimDiff:    stickData.aimDiff     ?? 0,
      } : null,
      outcome:       null,
      postShotBalls: null,
    };

    if (!this._ready) {
      this._queue.push({ type: 'startShot', record });
      return -1;
    }

    return this._put(record);
  }

  // ── Record outcome after shot animation ends ──────────────────────────────
  async recordOutcome(shotId, outcome, postShotBalls) {
    if (shotId < 0 || !this._ready) return;

    const tx    = this.db.transaction(this.STORE, 'readwrite');
    const store = tx.objectStore(this.STORE);

    return new Promise((resolve) => {
      const getReq = store.get(shotId);
      getReq.onsuccess = () => {
        const record = getReq.result;
        if (!record) { resolve(); return; }
        record.outcome = {
          pocketed:    [...(outcome.pocketed || [])],
          cuePocketed: !!outcome.cuePocketed,
          success:     !!outcome.success,
          duration:    outcome.duration ?? 0,
        };
        record.postShotBalls = (postShotBalls || []).map(b => ({ id: b.id, x: b.x, y: b.y }));
        store.put(record).onsuccess = resolve;
      };
    });
  }

  // ── Statistics ───────────────────────────────────────────────────────────
  async getStats() {
    if (!this._ready) return null;
    const all = await this._getAll();
    const completed = all.filter(r => r.outcome);
    const successes = completed.filter(r => r.outcome.success);
    const byDifficulty = {};
    for (const r of completed) {
      const d = r.shot.difficulty;
      if (!byDifficulty[d]) byDifficulty[d] = { total: 0, success: 0 };
      byDifficulty[d].total++;
      if (r.outcome.success) byDifficulty[d].success++;
    }
    return {
      total:        all.length,
      completed:    completed.length,
      successRate:  completed.length ? successes.length / completed.length : 0,
      byDifficulty,
    };
  }

  // ── Export as JSON ────────────────────────────────────────────────────────
  async exportJSON() {
    if (!this._ready) return '[]';
    const all = await this._getAll();
    return JSON.stringify(all, null, 2);
  }

  // ── Delete all records ────────────────────────────────────────────────────
  async clear() {
    if (!this._ready) return;
    const tx = this.db.transaction(this.STORE, 'readwrite');
    tx.objectStore(this.STORE).clear();
  }

  // ── Private helpers ───────────────────────────────────────────────────────
  async _put(record) {
    return new Promise((resolve, reject) => {
      const tx  = this.db.transaction(this.STORE, 'readwrite');
      const req = tx.objectStore(this.STORE).add(record);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => resolve(-1);
    });
  }

  async _getAll() {
    return new Promise((resolve) => {
      const tx  = this.db.transaction(this.STORE, 'readonly');
      const req = tx.objectStore(this.STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror   = () => resolve([]);
    });
  }

  _flushQueue() {
    for (const item of this._queue) {
      if (item.type === 'startShot') this._put(item.record);
    }
    this._queue = [];
  }
}

const trainingDB = new TrainingDB();

// ── Power suggestion helper ──────────────────────────────────────────────────
// Returns suggested power [0.2, 0.9] based on shot geometry.
function suggestedPower(shot, cueBall) {
  if (!shot) return 0.5;
  const distCB = V.dist(cueBall, shot.ghost);
  const distOB = V.dist(shot.objBall, shot.pocket);
  const total  = distCB + distOB;

  // Normalise to table diagonal (~2835 mm for a 9-foot table)
  const maxDist   = Math.sqrt(C.TABLE_W ** 2 + C.TABLE_H ** 2);
  const basePower = total / maxDist;

  // Harder cuts need a touch more pace for safety margin
  const cutBoost = 1 + (shot.cut / 70) * 0.25;

  return Math.min(0.88, Math.max(0.20, basePower * cutBoost));
}
