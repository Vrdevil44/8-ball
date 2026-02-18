'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  Main Application Controller
// ═══════════════════════════════════════════════════════════════════════════

class App {
  constructor() {
    // DOM refs
    this.canvas      = document.getElementById('main-canvas');
    this.videoEl     = document.getElementById('camera-feed');
    this.statusEl    = document.getElementById('status-text');

    // Core modules
    this.renderer    = new Renderer(this.canvas);
    this.gameState   = new GameState();
    this.camera      = new CameraManager();

    // Application state
    this.mode        = 'demo';   // 'demo' | 'camera'
    this.balls       = [];
    this.selectedBall = null;    // currently selected object ball
    this.showAI      = true;
    this.bestShots   = [];
    this.currentShot = null;     // currently displayed/recommended shot
    this.power       = 0.55;     // shot power 0-1

    // Input state
    this.pointerDown  = false;
    this.aimMode      = false;   // user is dragging to aim manually
    this.manualAim    = null;    // { from, to, ghost, obPath, cbPath }
    this.draggingBall = null;    // ball being dragged in setup mode

    // Render loop
    this._rafId = null;
    this._lastTime = 0;

    // Detect browser features
    this.canvasSupportsRoundRect = typeof CanvasRenderingContext2D.prototype.roundRect === 'function';
    if (!this.canvasSupportsRoundRect) {
      // Polyfill for older browsers
      CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
        this.beginPath();
        this.moveTo(x + r, y);
        this.arcTo(x + w, y, x + w, y + h, r);
        this.arcTo(x + w, y + h, x, y + h, r);
        this.arcTo(x, y + h, x, y, r);
        this.arcTo(x, y, x + w, y, r);
        this.closePath();
      };
    }

    this._init();
  }

  // ── Initialisation ───────────────────────────────────────────────────────
  _init() {
    this._bindEvents();
    this._newGame();
    this._startRenderLoop();
    this._updateUI();
  }

  _newGame() {
    this.gameState = new GameState();
    this.balls = GameState.makeRackBalls();
    this.selectedBall = null;
    this.currentShot  = null;
    this.manualAim    = null;
    this._computeBestShots();
    this._updateUI();
    this._setStatus('Player 1: Break! Click the recommended shot or aim manually.');
  }

  _rackBalls() {
    this.balls = GameState.makeRackBalls();
    this.selectedBall = null;
    this.currentShot  = null;
    this.manualAim    = null;
    this._computeBestShots();
    this._setStatus('Balls racked. Click "Shoot!" or aim manually.');
  }

  // ── AI shot computation ──────────────────────────────────────────────────
  _computeBestShots() {
    this.bestShots  = shotEngine.findBestShots(this.balls, this.gameState);
    this.currentShot = this.bestShots.length > 0 ? this.bestShots[0] : null;
    this._updateShotPanel();
  }

  // ── Render loop ──────────────────────────────────────────────────────────
  _startRenderLoop() {
    const loop = (ts) => {
      this._rafId = requestAnimationFrame(loop);

      if (this.renderer.animating) {
        const still = this.renderer.tickAnimation(this._renderState());
        if (!still) {
          // Animation just ended
          this._onAnimationEnd();
        }
      }

      if (this.mode === 'camera' && this.camera.active) {
        this.renderer.drawCameraFrame(this.videoEl);
      }

      this.renderer.render(this._renderState());
    };
    this._rafId = requestAnimationFrame(loop);
  }

  _renderState() {
    return {
      balls:       this.balls,
      bestShot:    this.showAI && !this.renderer.animating ? this.currentShot : null,
      selectedBall: this.selectedBall ? this.selectedBall.id : -1,
      showAI:      this.showAI,
      manualAim:   this.aimMode ? this.manualAim : null,
      mode:        this.mode,
    };
  }

  // ── Input binding ────────────────────────────────────────────────────────
  _bindEvents() {
    // Canvas mouse / touch
    const getPos = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const src  = e.touches ? e.touches[0] : e;
      return {
        x: src.clientX - rect.left,
        y: src.clientY - rect.top,
      };
    };

    const onDown = (e) => {
      e.preventDefault();
      if (this.renderer.animating) return;
      const pos = getPos(e);
      this._handlePointerDown(pos.x, pos.y);
    };
    const onMove = (e) => {
      e.preventDefault();
      if (!this.pointerDown) return;
      const pos = getPos(e);
      this._handlePointerMove(pos.x, pos.y);
    };
    const onUp = (e) => {
      e.preventDefault();
      const pos = getPos(e);
      this._handlePointerUp(pos.x, pos.y);
      this.pointerDown = false;
    };

    this.canvas.addEventListener('mousedown',  onDown);
    this.canvas.addEventListener('mousemove',  onMove);
    this.canvas.addEventListener('mouseup',    onUp);
    this.canvas.addEventListener('touchstart', onDown, { passive: false });
    this.canvas.addEventListener('touchmove',  onMove, { passive: false });
    this.canvas.addEventListener('touchend',   onUp,   { passive: false });

    // Buttons
    document.getElementById('btn-new-game').addEventListener('click', () => this._newGame());
    document.getElementById('btn-rack').addEventListener('click', () => this._rackBalls());
    document.getElementById('btn-shoot').addEventListener('click', () => this._executeRecommendedShot());
    document.getElementById('btn-random').addEventListener('click', () => this._randomLayout());
    document.getElementById('btn-toggle-ai').addEventListener('click', () => this._toggleAI());
    document.getElementById('btn-camera').addEventListener('click', () => this._toggleCamera());
    document.getElementById('power-slider').addEventListener('input', (e) => {
      this.power = parseInt(e.target.value) / 100;
      document.getElementById('power-label').textContent = `${Math.round(this.power * 100)}%`;
    });

    // Mode tabs
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode;
        this._switchMode(mode);
      });
    });

    // Felt color selector
    document.getElementById('felt-select')?.addEventListener('change', (e) => {
      this.camera.setFeltMode(e.target.value);
    });

    // Window resize
    window.addEventListener('resize', () => {
      this.renderer._resize();
    });
  }

  // ── Pointer handling ─────────────────────────────────────────────────────
  _handlePointerDown(cx, cy) {
    this.pointerDown = true;
    if (this.renderer.animating) return;

    const hit = this.renderer.hitTestBall(cx, cy, this.balls);

    if (hit && hit.id === 0) {
      // Clicked cue ball – start aim drag
      this.aimMode = true;
      this.manualAim = { from: { x: hit.x, y: hit.y }, to: null };
      return;
    }

    if (hit && hit.id !== 0) {
      // Clicked object ball – select it
      this.selectedBall = hit;

      // Find best shot for this specific ball
      const shots = this.bestShots.filter(s => s.objBall.id === hit.id);
      this.currentShot = shots.length > 0 ? shots[0] : null;
      this._updateShotPanel();
      this._setStatus(`Ball ${hit.info.name} selected. Click a pocket or use AI shot.`);
      return;
    }

    // Clicked on a pocket with ball selected – compute manual shot
    const pocket = this.renderer.hitTestPocket(cx, cy);
    if (pocket && this.selectedBall) {
      const obj = this.selectedBall;
      const cue = this.balls.find(b => b.id === 0);
      const ghost  = shotEngine.ghostBall(obj, pocket);
      const cbPath = shotEngine.cueBallPath(cue, ghost, obj, 'natural');
      const obPath = shotEngine.objBallPath(obj, pocket);
      this.currentShot = { objBall: obj, pocket, ghost, cbPath, obPath, cut: 0, score: 0, difficulty: null };
      this._setStatus(`Aim set for ball ${obj.info.name} → ${pocket.label}. Click "Shoot!"`);
    }
  }

  _handlePointerMove(cx, cy) {
    if (!this.aimMode || !this.manualAim) return;

    const tp  = this.renderer.canvasToTable(cx, cy);
    const cue = this.balls.find(b => b.id === 0);
    this.manualAim.to = tp;

    // Check if aim line intersects an object ball
    const dir = V.norm(V.sub(tp, cue));
    const ahead = { x: cue.x + dir.x * 3000, y: cue.y + dir.y * 3000 };

    let closestBall = null, closestDist = Infinity;
    for (const b of this.balls) {
      if (b.id === 0 || b.pocketed) continue;
      const perp = V.pointLinePerp(b, cue, dir);
      if (perp < C.BALL_R * 2) {
        const d = V.dist(cue, b);
        if (d < closestDist) { closestDist = d; closestBall = b; }
      }
    }

    if (closestBall) {
      const ghost  = shotEngine.ghostBall(closestBall, { x: tp.x, y: tp.y });
      // pick best pocket for this ball
      const shots  = this.bestShots.filter(s => s.objBall.id === closestBall.id);
      const pocket = shots.length > 0 ? shots[0].pocket : C.POCKETS[0];
      const ghost2 = shotEngine.ghostBall(closestBall, pocket);
      this.manualAim.ghost  = ghost2;
      this.manualAim.obPath = shotEngine.objBallPath(closestBall, pocket);
      this.manualAim.cbPath = shotEngine.cueBallPath(cue, ghost2, closestBall, 'natural');
    } else {
      this.manualAim.ghost  = null;
      this.manualAim.obPath = null;
      this.manualAim.cbPath = null;
    }
  }

  _handlePointerUp(cx, cy) {
    if (this.aimMode && this.manualAim && this.manualAim.to) {
      // Execute the manual shot
      this._executeManualShot();
    }
    this.aimMode = false;
    this.manualAim = null;
  }

  // ── Shot execution ───────────────────────────────────────────────────────
  _executeRecommendedShot() {
    if (this.renderer.animating) return;
    if (!this.currentShot) {
      this._setStatus('No shot recommended. Position balls or try a random layout.');
      return;
    }
    const cue = this.balls.find(b => b.id === 0);
    if (!cue) return;

    const vel = shotEngine.shotVelocity(cue, this.currentShot, this.power);
    this._runShot(vel.vx, vel.vy);
  }

  _executeManualShot() {
    const cue = this.balls.find(b => b.id === 0);
    if (!cue || !this.manualAim || !this.manualAim.to) return;

    const dir = V.norm(V.sub(this.manualAim.to, cue));
    const speed = 500 + this.power * 3500;
    this._runShot(dir.x * speed, dir.y * speed);
  }

  _runShot(vx, vy) {
    if (this.renderer.animating) return;

    const result = physics.simulate(this.balls, 0, vx, vy);
    this._setStatus('Shot in progress...');

    this.renderer.startAnimation(result.frames, this.balls, () => {
      this._onShotComplete(result);
    });
  }

  _onAnimationEnd() {
    // Called by renderer when animation finishes
    // (handled via callback in startAnimation)
  }

  _onShotComplete(result) {
    // Update ball positions to final simulation state
    if (result.finalBalls) {
      for (const fb of result.finalBalls) {
        const ball = this.balls.find(b => b.id === fb.id);
        if (ball) {
          ball.x = fb.x; ball.y = fb.y;
          ball.vx = fb.vx; ball.vy = fb.vy;
          ball.pocketed = fb.pocketed;
        }
      }
    }

    // Was cue ball pocketed?
    const cuePocketed = result.pocketed.has(0);

    // Process game state
    this.gameState.processShot(result.pocketed, cuePocketed);

    if (cuePocketed) {
      const cue = this.balls.find(b => b.id === 0);
      if (cue) {
        cue.pocketed = false;
        cue.x = C.HEAD_SPOT.x;
        cue.y = C.HEAD_SPOT.y;
        cue.vx = 0; cue.vy = 0;
      }
    }

    this._computeBestShots();
    this._updateUI();
    this._setStatus(this.gameState.message);

    if (this.gameState.phase === GAME_PHASE.GAME_OVER) {
      setTimeout(() => {
        this._setStatus(`🎱 ${this.gameState.message} Press "New Game" to play again.`);
      }, 500);
    }
  }

  // ── Mode switching ───────────────────────────────────────────────────────
  _switchMode(mode) {
    this.mode = mode;
    document.querySelectorAll('.tab-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });

    const cameraPanel = document.getElementById('camera-controls');
    if (cameraPanel) cameraPanel.style.display = mode === 'camera' ? 'block' : 'none';

    if (mode !== 'camera') {
      this.camera.stop();
      this.videoEl.style.display = 'none';
    }
  }

  async _toggleCamera() {
    if (this.camera.active) {
      this.camera.stop();
      this.videoEl.style.display = 'none';
      document.getElementById('btn-camera').textContent = 'Start Camera';
      this._switchMode('demo');
      return;
    }

    this._setStatus('Requesting camera access…');
    const ok = await this.camera.start(this.videoEl);

    if (!ok) {
      this._setStatus('Camera unavailable. Using demo mode.');
      return;
    }

    this.videoEl.style.display = 'block';
    document.getElementById('btn-camera').textContent = 'Stop Camera';
    this._switchMode('camera');

    this.camera.onDetect = (result) => {
      if (!result) return;
      // Merge detected balls into game state
      // (In a real deployment this would replace ball positions)
      this._setStatus(`Detected: ${result.balls.length} balls on ${Math.round(result.tableBounds.w)}×${Math.round(result.tableBounds.h)}px table`);
    };
  }

  // ── AI toggle ────────────────────────────────────────────────────────────
  _toggleAI() {
    this.showAI = !this.showAI;
    document.getElementById('btn-toggle-ai').textContent = `AI: ${this.showAI ? 'ON' : 'OFF'}`;
    document.getElementById('btn-toggle-ai').classList.toggle('btn-off', !this.showAI);
  }

  // ── Random layout ────────────────────────────────────────────────────────
  _randomLayout() {
    const count = parseInt(document.getElementById('ball-count')?.value || '7');
    this.balls = GameState.makeRandomBalls(Math.max(1, Math.min(15, count)));
    this.gameState = new GameState();
    this.gameState.phase = GAME_PHASE.OPEN_TABLE;
    this.selectedBall = null;
    this.currentShot  = null;
    this._computeBestShots();
    this._updateUI();
    this._setStatus('Random layout. AI is finding the best shot…');
  }

  // ── UI update ────────────────────────────────────────────────────────────
  _updateUI() {
    this._updatePlayerPanel();
    this._updateBallsPanel();
    this._updateShotPanel();
  }

  _updatePlayerPanel() {
    const gs = this.gameState;
    const p1g = document.getElementById('p1-group');
    const p2g = document.getElementById('p2-group');
    const ct  = document.getElementById('current-turn');

    if (p1g) p1g.textContent = gs.groups[1] || 'Open';
    if (p2g) p2g.textContent = gs.groups[2] || 'Open';
    if (ct)  ct.textContent  = `Player ${gs.currentPlayer}`;

    // Phase badge
    const phaseEl = document.getElementById('phase-badge');
    if (phaseEl) {
      phaseEl.textContent = gs.phase.replace('_', ' ');
      phaseEl.className   = 'phase-badge phase-' + gs.phase.toLowerCase();
    }
  }

  _updateBallsPanel() {
    const el = document.getElementById('balls-remaining');
    if (!el) return;

    el.innerHTML = '';
    const pocketed = this.gameState.pocketed;

    C.BALLS.slice(1).forEach(info => {
      const span = document.createElement('span');
      span.className = 'ball-chip' + (pocketed.has(info.id) ? ' pocketed' : '');
      span.title     = `Ball ${info.name} – ${pocketed.has(info.id) ? 'pocketed' : 'on table'}`;
      span.style.background = info.css;
      span.style.color = (info.type === 'cue' || info.type === 'stripe') ? '#111' : '#fff';
      span.textContent = info.name;
      el.appendChild(span);
    });
  }

  _updateShotPanel() {
    const shot = this.currentShot;
    document.getElementById('shot-ball').textContent   = shot ? `#${shot.objBall.info.name} (${shot.objBall.info.type})` : '—';
    document.getElementById('shot-pocket').textContent = shot ? shot.pocket.label : '—';
    document.getElementById('shot-score').textContent  = shot ? `${shot.score}/100` : '—';
    document.getElementById('shot-cut').textContent    = shot ? `${Math.round(shot.cut)}°` : '—';

    const diffEl = document.getElementById('shot-difficulty');
    if (diffEl && shot && shot.difficulty) {
      diffEl.textContent = shot.difficulty.label;
      diffEl.style.color = shot.difficulty.color;
    } else if (diffEl) {
      diffEl.textContent = '—';
      diffEl.style.color = '';
    }

    // Number of candidates
    const candEl = document.getElementById('shot-candidates');
    if (candEl) candEl.textContent = this.bestShots.length > 0 ? `${this.bestShots.length} shots found` : 'No shots available';
  }

  _setStatus(msg) {
    if (this.statusEl) this.statusEl.textContent = msg;
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────
let app;
document.addEventListener('DOMContentLoaded', () => {
  app = new App();
});
