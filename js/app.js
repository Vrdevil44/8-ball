'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  App – AR-first application controller
//
//  Modes:
//   'demo'   – virtual table, no camera (fallback / practice)
//   'ar'     – full-screen camera + AR overlays
//
//  AR sub-states (managed by ARSession):
//   'idle' → 'camera' → 'tapping' → 'calibrated'
//   'idle' → 'xr'  (if WebXR available)
// ═══════════════════════════════════════════════════════════════════════════

class App {
  constructor() {
    // DOM refs
    this.canvas      = document.getElementById('ar-canvas');
    this.videoEl     = document.getElementById('camera-feed');
    this.overlayRoot = document.getElementById('ar-overlay');

    // Core modules
    this.renderer    = new ARRenderer(this.canvas);
    this.gameState   = new GameState();
    this.arSession   = new ARSession(this.videoEl);
    this.camManager  = new CameraManager();
    this.tracker     = new BallTracker();

    // Game state
    this.mode        = 'demo';   // 'demo' | 'ar'
    this.balls       = [];
    this.bestShots   = [];
    this.currentShot = null;
    this.showAI      = true;
    this.power       = 0.55;
    this.stickResult = null;
    this.selectedBall = null;

    // Manual aim (demo mode)
    this.pointerDown  = false;
    this.aimMode      = false;
    this.manualAim    = null;

    // Detection
    this.lastDetection  = null;
    this.detectionBalls = [];
    this.mergeDetected  = true;  // auto-merge detected balls into game state

    // Shot timing (for training)
    this._shotStartTime = 0;
    this._pendingShotId = -1;

    // roundRect polyfill for older browsers
    if (typeof CanvasRenderingContext2D.prototype.roundRect !== 'function') {
      CanvasRenderingContext2D.prototype.roundRect = function(x, y, w, h, r) {
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

  // ── Initialise ────────────────────────────────────────────────────────────
  _init() {
    // Open training DB (non-blocking)
    trainingDB.open().catch(() => {});

    // Wire up AR session callbacks
    this.arSession.onCalibrated = () => {
      this._setStatus('Table calibrated! AI is analysing shots…');
      this.camManager.setARSession(this.arSession);
      this._updateHUD();
    };
    this.arSession.onCornerTapped = (idx) => {
      const names = this.arSession.cornerNames;
      const msg = idx < 3
        ? `✓ Corner ${idx + 1} set. Tap ${names[idx + 1]} corner.`
        : 'Processing calibration…';
      this._setStatus(msg);
    };
    this.arSession.onError = (err) => {
      const msgs = {
        'NotAllowedError':   'Camera permission denied.',
        'NotFoundError':     'No camera found.',
        'NotReadableError':  'Camera in use by another app.',
        'camera-error':      'Camera unavailable.',
        'homography-degenerate': 'Corner points too close. Please re-tap.',
      };
      this._setStatus(msgs[err] || 'Camera error. Try again.');
    };

    // Wire up camera detection
    this.camManager.onDetect = (result) => this._onDetect(result);

    // Ball tracker callbacks
    this.tracker.onUpdate = (states) => this._onTrackUpdate(states);
    this.tracker.onDone   = (states) => this._onTrackDone(states);

    // Start
    this._newGame();
    this._bindEvents();
    this._startRenderLoop();
    this._updateHUD();

    // Check WebXR availability asynchronously, show button if supported
    ARSession.isXRSupported().then(supported => {
      const btn = document.getElementById('btn-xr');
      if (btn) btn.style.display = supported ? 'inline-flex' : 'none';
    });
  }

  // ── Game setup ────────────────────────────────────────────────────────────
  _newGame() {
    this.gameState    = new GameState();
    this.balls        = GameState.makeRackBalls();
    this.selectedBall = null;
    this.currentShot  = null;
    this.manualAim    = null;
    this._computeBestShots();
    this._updateHUD();
    this._setStatus('New game! Player 1: Break.');
  }

  _rackBalls() {
    this.balls        = GameState.makeRackBalls();
    this.selectedBall = null;
    this.currentShot  = null;
    this.manualAim    = null;
    this._computeBestShots();
    this._setStatus('Balls racked.');
  }

  _randomLayout(count = 7) {
    this.balls     = GameState.makeRandomBalls(count);
    this.gameState = new GameState();
    this.gameState.phase = GAME_PHASE.OPEN_TABLE;
    this.selectedBall = null;
    this.currentShot  = null;
    this._computeBestShots();
    this._updateHUD();
    this._setStatus('Random layout. AI is finding the best shot…');
  }

  // ── AI shot computation ───────────────────────────────────────────────────
  _computeBestShots() {
    this.bestShots  = shotEngine.findBestShots(this.balls, this.gameState);
    this.currentShot = this.bestShots.length > 0 ? this.bestShots[0] : null;

    // Annotate with suggested power
    if (this.currentShot) {
      const cue = this.balls.find(b => b.id === 0);
      if (cue) this.currentShot.suggestedPower = suggestedPower(this.currentShot, cue);
    }

    this._updateShotPanel();
  }

  // ── Render loop ───────────────────────────────────────────────────────────
  _startRenderLoop() {
    const loop = () => {
      requestAnimationFrame(loop);

      if (this.renderer.animating) {
        const still = this.renderer.tickAnimation(this._renderState());
        if (!still) this._onAnimationEnd();
      }

      this.renderer.render(this._renderState());
    };
    requestAnimationFrame(loop);
  }

  _renderState() {
    return {
      balls:        this.balls,
      bestShot:     this.showAI && !this.renderer.animating ? this.currentShot : null,
      selectedBall: this.selectedBall ? this.selectedBall.id : -1,
      showAI:       this.showAI,
      manualAim:    this.aimMode ? this.manualAim : null,
      mode:         this.mode,
      arSession:    this.arSession,
      stickResult:  this.mode === 'ar' ? this.stickResult : null,
    };
  }

  // ── Detection callback ────────────────────────────────────────────────────
  _onDetect(result) {
    if (!result) return;
    this.lastDetection = result;
    this.stickResult   = result.stick || null;

    // Update HUD detection confidence
    const confEl = document.getElementById('detect-conf');
    if (confEl) {
      const pct = Math.round((result.confidence || 0) * 100);
      confEl.textContent = `${pct}%`;
      confEl.style.color = pct > 70 ? '#00e676' : pct > 40 ? '#FFD600' : '#ff5252';
    }

    // If calibrated and user wants auto-merge, update game ball positions
    if (this.arSession.calibrated && this.mergeDetected && result.balls.length >= 2) {
      this._mergeBalls(result.balls);
      this._computeBestShots();
    }

    // Update stick info in HUD
    if (result.stick) this._updateStickHUD(result.stick);

    // Update detection count
    const ballsEl = document.getElementById('detect-balls');
    if (ballsEl) ballsEl.textContent = result.balls.length;
  }

  // ── Merge detected balls into game state ──────────────────────────────────
  _mergeBalls(detected) {
    for (const det of detected) {
      const existing = this.balls.find(b => b.id === det.id);
      if (existing && !existing.pocketed) {
        // Smooth update (EMA)
        const alpha = 0.35;
        existing.x = existing.x * (1 - alpha) + det.x * alpha;
        existing.y = existing.y * (1 - alpha) + det.y * alpha;
      } else if (!existing) {
        // New ball detected
        this.balls.push(det);
      }
    }
  }

  // ── Stick HUD ─────────────────────────────────────────────────────────────
  _updateStickHUD(stick) {
    const el = document.getElementById('stick-info');
    if (!el) return;
    const pct = Math.round(stick.confidence * 100);
    el.textContent = `🎱 Cue ${pct}%`;
    el.style.display = pct > 20 ? 'flex' : 'none';
  }

  // ── Ball tracker updates ──────────────────────────────────────────────────
  _onTrackUpdate(states) {
    // Live update ball positions during shot flight
    for (const st of states) {
      const ball = this.balls.find(b => b.id === st.id);
      if (ball && st.moving) {
        ball.x = st.x;
        ball.y = st.y;
      }
    }
  }

  _onTrackDone(states) {
    // Shot tracking finished → record outcome
    const pocketed = new Set(
      states.filter(s => s.pocketed).map(s => s.id)
    );
    const cuePocketed = pocketed.has(0);

    // Record outcome in training DB
    if (this._pendingShotId >= 0) {
      const duration = Date.now() - this._shotStartTime;
      const intended = this.currentShot?.objBall?.id;
      const success  = intended !== undefined && pocketed.has(intended);
      trainingDB.recordOutcome(
        this._pendingShotId,
        { pocketed: [...pocketed], cuePocketed, success, duration },
        states
      ).catch(() => {});
      this._pendingShotId = -1;
    }

    this.gameState.processShot(pocketed, cuePocketed);
    if (cuePocketed) {
      const cue = this.balls.find(b => b.id === 0);
      if (cue) { cue.pocketed = false; cue.x = C.HEAD_SPOT.x; cue.y = C.HEAD_SPOT.y; cue.vx = 0; cue.vy = 0; }
    }

    this._computeBestShots();
    this._updateHUD();
    this._setStatus(this.gameState.message);
  }

  _onAnimationEnd() {
    // (handled via callback in startAnimation)
  }

  _onShotComplete(result) {
    if (result.finalBalls) {
      for (const fb of result.finalBalls) {
        const ball = this.balls.find(b => b.id === fb.id);
        if (ball) { ball.x = fb.x; ball.y = fb.y; ball.vx = fb.vx; ball.vy = fb.vy; ball.pocketed = fb.pocketed; }
      }
    }

    const cuePocketed = result.pocketed.has(0);
    this.gameState.processShot(result.pocketed, cuePocketed);

    if (cuePocketed) {
      const cue = this.balls.find(b => b.id === 0);
      if (cue) { cue.pocketed = false; cue.x = C.HEAD_SPOT.x; cue.y = C.HEAD_SPOT.y; cue.vx = 0; cue.vy = 0; }
    }

    // Record training outcome
    if (this._pendingShotId >= 0) {
      const duration = Date.now() - this._shotStartTime;
      const intended = this.currentShot?.objBall?.id;
      const success  = intended !== undefined && result.pocketed.has(intended);
      trainingDB.recordOutcome(
        this._pendingShotId,
        { pocketed: [...result.pocketed], cuePocketed, success, duration },
        result.finalBalls || []
      ).catch(() => {});
      this._pendingShotId = -1;
    }

    this._computeBestShots();
    this._updateHUD();
    this._setStatus(this.gameState.message);

    if (this.gameState.phase === GAME_PHASE.GAME_OVER) {
      setTimeout(() => this._setStatus(`🎱 ${this.gameState.message} Tap "New Game".`), 500);
    }
  }

  // ── Shot execution ────────────────────────────────────────────────────────
  _executeRecommendedShot() {
    if (this.renderer.animating) return;
    if (!this.currentShot) { this._setStatus('No shot found. Calibrate table or use demo mode.'); return; }
    const cue = this.balls.find(b => b.id === 0);
    if (!cue) return;

    this._recordShotStart();
    const vel = shotEngine.shotVelocity(cue, this.currentShot, this.power);
    this._runShot(vel.vx, vel.vy);
  }

  _executeManualShot() {
    const cue = this.balls.find(b => b.id === 0);
    if (!cue || !this.manualAim?.to) return;
    this._recordShotStart();
    const dir   = V.norm(V.sub(this.manualAim.to, cue));
    const speed = 500 + this.power * 3500;
    this._runShot(dir.x * speed, dir.y * speed);
  }

  _runShot(vx, vy) {
    if (this.renderer.animating) return;
    const result = physics.simulate(this.balls, 0, vx, vy);
    this._setStatus('Shot in progress…');

    // In AR mode, start ball tracker
    if (this.mode === 'ar' && this.arSession.calibrated) {
      this.tracker.start(this.videoEl, this.arSession, this.balls);
    }

    this.renderer.startAnimation(result.frames, this.balls, () => {
      this._onShotComplete(result);
    });
  }

  _recordShotStart() {
    this._shotStartTime = Date.now();
    const cue = this.balls.find(b => b.id === 0);
    trainingDB.startShot(
      this.balls,
      { ...this.currentShot, power: this.power },
      this.stickResult ? { detected: true, confidence: this.stickResult.confidence, aimDiff: 0 } : null
    ).then(id => { this._pendingShotId = id || -1; }).catch(() => {});
  }

  // ── AR mode toggle ────────────────────────────────────────────────────────
  async _startAR() {
    this._setStatus('Starting camera…');
    this.mode = 'ar';
    this._updateModeBtns();

    // Show video element (full-screen)
    this.videoEl.style.display = 'block';

    // Try WebXR first
    const xrOk = await this.arSession.startXR(this.overlayRoot);
    if (!xrOk) {
      // Fallback to getUserMedia
      const camOk = await this.arSession.startCamera();
      if (!camOk) {
        this._setStatus('Camera unavailable. Using demo mode.');
        this._stopAR();
        return;
      }
    }

    this.camManager.setARSession(this.arSession);
    this.camManager.startDetection(this.videoEl, 10);

    // Show calibration prompt if not using XR automatic plane detection
    if (!this.arSession.xrSession) {
      this._setStatus('Camera ready. Tap "Calibrate Table" to begin.');
    } else {
      this._setStatus('WebXR AR started. Point at table surface.');
    }

    this._updateHUD();
    document.getElementById('ar-controls').style.display = 'flex';
    document.getElementById('demo-controls').style.display = 'none';
  }

  _stopAR() {
    this.mode = 'demo';
    this.arSession.stopCamera();
    this.camManager.stopDetection();
    this.videoEl.style.display = 'none';
    this.stickResult = null;
    this._updateModeBtns();
    this._updateHUD();
    document.getElementById('ar-controls').style.display = 'none';
    document.getElementById('demo-controls').style.display = 'flex';
  }

  // ── Table calibration ─────────────────────────────────────────────────────
  _startCalibration() {
    if (!this.arSession.running) { this._setStatus('Start camera first.'); return; }
    this.arSession.beginCalibration();
    this._setStatus('Tap the 4 corners of the table: Top-Left first.');
  }

  // ── Canvas tap/click in AR mode ───────────────────────────────────────────
  _handleARTap(sx, sy) {
    if (this.arSession.state === 'tapping') {
      this.arSession.tapCorner(sx, sy);
      return;
    }

    if (!this.arSession.calibrated) return;

    // Convert screen tap → table coords
    const tp = this.arSession.screenToTable(sx, sy);
    if (tp.x < 0 || tp.x > C.TABLE_W || tp.y < 0 || tp.y > C.TABLE_H) return;

    // Hit-test against balls
    let hitBall = null;
    for (const b of this.balls) {
      if (b.pocketed) continue;
      if (V.dist(b, tp) <= C.BALL_R * 2.5) { hitBall = b; break; }
    }

    if (hitBall) {
      if (hitBall.id === 0) {
        // Cue ball selected – could start aiming drag
        this._setStatus('Cue ball selected. Tap a pocket or use AI shot.');
      } else {
        this.selectedBall = hitBall;
        const shots = this.bestShots.filter(s => s.objBall.id === hitBall.id);
        this.currentShot = shots.length > 0 ? shots[0] : null;
        if (this.currentShot) {
          const cue = this.balls.find(b => b.id === 0);
          if (cue) this.currentShot.suggestedPower = suggestedPower(this.currentShot, cue);
        }
        this._updateShotPanel();
        this._setStatus(`Ball ${hitBall.info?.name} selected.`);
      }
      return;
    }

    // Tap on a pocket (AR projected)
    let hitPocket = null;
    for (const p of C.POCKETS) {
      const sp = this.arSession.tableToScreen(p.x, p.y);
      if (Math.hypot(sx - sp.x, sy - sp.y) <= 25) { hitPocket = p; break; }
    }

    if (hitPocket && this.selectedBall) {
      const cue   = this.balls.find(b => b.id === 0);
      const ghost = shotEngine.ghostBall(this.selectedBall, hitPocket);
      const cbPath = shotEngine.cueBallPath(cue, ghost, this.selectedBall, 'natural');
      const obPath = shotEngine.objBallPath(this.selectedBall, hitPocket);
      this.currentShot = {
        objBall: this.selectedBall, pocket: hitPocket, ghost, cbPath, obPath,
        cut: 0, score: 0, difficulty: null, suggestedPower: suggestedPower({ objBall: this.selectedBall, pocket: hitPocket, ghost, cut: 0 }, cue),
      };
      this._updateShotPanel();
      this._setStatus(`Aim set: ${this.selectedBall.info?.name} → ${hitPocket.label}`);
    }
  }

  // ── Pointer handling (demo mode) ──────────────────────────────────────────
  _handlePointerDown(cx, cy) {
    this.pointerDown = true;
    if (this.renderer.animating) return;

    if (this.mode === 'ar') {
      this._handleARTap(cx, cy);
      return;
    }

    const hit = this.renderer.hitTestBall(cx, cy, this.balls);
    if (hit?.id === 0) {
      this.aimMode   = true;
      this.manualAim = { from: { x: hit.x, y: hit.y }, to: null };
      return;
    }
    if (hit && hit.id !== 0) {
      this.selectedBall = hit;
      const shots = this.bestShots.filter(s => s.objBall.id === hit.id);
      this.currentShot = shots.length > 0 ? shots[0] : null;
      if (this.currentShot) {
        const cue = this.balls.find(b => b.id === 0);
        if (cue) this.currentShot.suggestedPower = suggestedPower(this.currentShot, cue);
      }
      this._updateShotPanel();
      return;
    }

    const pocket = this.renderer.hitTestPocket(cx, cy);
    if (pocket && this.selectedBall) {
      const cue   = this.balls.find(b => b.id === 0);
      const ghost = shotEngine.ghostBall(this.selectedBall, pocket);
      const cbPath = shotEngine.cueBallPath(cue, ghost, this.selectedBall, 'natural');
      const obPath = shotEngine.objBallPath(this.selectedBall, pocket);
      this.currentShot = { objBall: this.selectedBall, pocket, ghost, cbPath, obPath, cut: 0, score: 0, difficulty: null };
    }
  }

  _handlePointerMove(cx, cy) {
    if (!this.aimMode || !this.manualAim) return;
    const tp  = this.renderer.canvasToTable(cx, cy);
    const cue = this.balls.find(b => b.id === 0);
    this.manualAim.to = tp;

    const dir = V.norm(V.sub(tp, cue));
    let closestBall = null, closestDist = Infinity;
    for (const b of this.balls) {
      if (b.id === 0 || b.pocketed) continue;
      if (V.pointLinePerp(b, cue, dir) < C.BALL_R * 2) {
        const d = V.dist(cue, b);
        if (d < closestDist) { closestDist = d; closestBall = b; }
      }
    }

    if (closestBall) {
      const shots  = this.bestShots.filter(s => s.objBall.id === closestBall.id);
      const pocket = shots.length > 0 ? shots[0].pocket : C.POCKETS[0];
      this.manualAim.ghost  = shotEngine.ghostBall(closestBall, pocket);
      this.manualAim.obPath = shotEngine.objBallPath(closestBall, pocket);
      this.manualAim.cbPath = shotEngine.cueBallPath(cue, this.manualAim.ghost, closestBall, 'natural');
    } else {
      this.manualAim.ghost = this.manualAim.obPath = this.manualAim.cbPath = null;
    }
  }

  _handlePointerUp() {
    if (this.aimMode && this.manualAim?.to) this._executeManualShot();
    this.aimMode   = false;
    this.manualAim = null;
    this.pointerDown = false;
  }

  // ── Event binding ─────────────────────────────────────────────────────────
  _bindEvents() {
    const getPos = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const src  = e.touches ? e.touches[0] : e;
      return { x: src.clientX - rect.left, y: src.clientY - rect.top };
    };

    const onDown = (e) => { e.preventDefault(); const p = getPos(e); this.pointerDown = true; this._handlePointerDown(p.x, p.y); };
    const onMove = (e) => { e.preventDefault(); if (!this.pointerDown) return; const p = getPos(e); this._handlePointerMove(p.x, p.y); };
    const onUp   = (e) => { e.preventDefault(); this._handlePointerUp(); };

    this.canvas.addEventListener('mousedown',  onDown);
    this.canvas.addEventListener('mousemove',  onMove);
    this.canvas.addEventListener('mouseup',    onUp);
    this.canvas.addEventListener('touchstart', onDown, { passive: false });
    this.canvas.addEventListener('touchmove',  onMove, { passive: false });
    this.canvas.addEventListener('touchend',   onUp,   { passive: false });

    // Mode buttons
    document.getElementById('btn-ar')?.addEventListener('click', () => {
      if (this.mode === 'ar') this._stopAR(); else this._startAR();
    });
    document.getElementById('btn-xr')?.addEventListener('click', async () => {
      this.mode = 'ar';
      this.videoEl.style.display = 'block';
      const ok = await this.arSession.startXR(this.overlayRoot);
      if (!ok) this._startAR(); // fallback
    });

    // AR controls
    document.getElementById('btn-calibrate')?.addEventListener('click', () => this._startCalibration());
    document.getElementById('btn-recalibrate')?.addEventListener('click', () => {
      this.arSession.resetCalibration();
      this._startCalibration();
    });
    document.getElementById('btn-merge-toggle')?.addEventListener('click', (e) => {
      this.mergeDetected = !this.mergeDetected;
      e.target.textContent = `Auto-merge: ${this.mergeDetected ? 'ON' : 'OFF'}`;
    });

    // Demo controls
    document.getElementById('btn-new-game')?.addEventListener('click', () => this._newGame());
    document.getElementById('btn-rack')?.addEventListener('click', () => this._rackBalls());
    document.getElementById('btn-shoot')?.addEventListener('click', () => this._executeRecommendedShot());
    document.getElementById('btn-random')?.addEventListener('click', () => {
      const raw = parseInt(document.getElementById('ball-count')?.value || '7', 10);
      this._randomLayout(isNaN(raw) ? 7 : Math.max(1, Math.min(15, raw)));
    });
    document.getElementById('btn-toggle-ai')?.addEventListener('click', (e) => {
      this.showAI = !this.showAI;
      e.target.textContent = `AI: ${this.showAI ? 'ON' : 'OFF'}`;
      e.target.classList.toggle('btn-off', !this.showAI);
    });
    document.getElementById('btn-shoot-ar')?.addEventListener('click', () => this._executeRecommendedShot());

    // Power sliders (both demo and AR)
    ['power-slider', 'power-slider-ar'].forEach(id => {
      document.getElementById(id)?.addEventListener('input', (e) => {
        const raw = parseFloat(e.target.value);
        this.power = isNaN(raw) ? 0.55 : Math.max(0.05, Math.min(1, raw / 100));
        document.getElementById('power-label').textContent = `${Math.round(this.power * 100)}%`;
        const arLbl = document.getElementById('power-label-ar');
        if (arLbl) arLbl.textContent = `${Math.round(this.power * 100)}%`;
        const otherSlider = id === 'power-slider' ? 'power-slider-ar' : 'power-slider';
        const other = document.getElementById(otherSlider);
        if (other) other.value = Math.round(this.power * 100);
      });
    });

    // Felt colour select
    document.getElementById('felt-select')?.addEventListener('change', (e) => {
      this.camManager.setFeltMode(e.target.value);
    });

    // Stats/export
    document.getElementById('btn-stats')?.addEventListener('click', async () => {
      const stats = await trainingDB.getStats();
      if (!stats) { this._setStatus('No training data yet.'); return; }
      const msg = `Shots: ${stats.completed} | Success: ${Math.round(stats.successRate * 100)}%`;
      this._setStatus(msg);
    });

    document.getElementById('btn-export')?.addEventListener('click', async () => {
      const json = await trainingDB.exportJSON();
      const blob = new Blob([json], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = '8ball_training.json';
      a.click();
      URL.revokeObjectURL(url);
    });

    // Panel toggle (mobile)
    document.getElementById('btn-panel-toggle')?.addEventListener('click', () => {
      document.getElementById('info-panel').classList.toggle('panel-open');
    });

    // Window resize
    window.addEventListener('resize', () => this.renderer._resize());
  }

  // ── UI updates ────────────────────────────────────────────────────────────
  _updateModeBtns() {
    const arBtn = document.getElementById('btn-ar');
    if (arBtn) arBtn.textContent = this.mode === 'ar' ? '✕ Stop AR' : '📷 Start AR';
  }

  _updateHUD() {
    this._updatePlayerPanel();
    this._updateBallsPanel();
    this._updateShotPanel();
    this._updateARStatus();
  }

  _updatePlayerPanel() {
    const gs = this.gameState;
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('p1-group', gs.groups?.[1] || 'Open');
    set('p2-group', gs.groups?.[2] || 'Open');
    set('current-turn', `Player ${gs.currentPlayer}`);
    const ph = document.getElementById('phase-badge');
    if (ph) { ph.textContent = (gs.phase || '').replace('_', ' '); ph.className = `phase-badge phase-${(gs.phase || '').toLowerCase()}`; }
  }

  _updateBallsPanel() {
    const el = document.getElementById('balls-remaining');
    if (!el) return;
    el.innerHTML = '';
    C.BALLS.slice(1).forEach(info => {
      const span = document.createElement('span');
      span.className = 'ball-chip' + (this.gameState.pocketed.has(info.id) ? ' pocketed' : '');
      span.style.background = info.css;
      span.style.color = ['cue','stripe'].includes(info.type) ? '#111' : '#fff';
      span.textContent = info.name;
      el.appendChild(span);
    });
  }

  _updateShotPanel() {
    const shot = this.currentShot;
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('shot-ball',    shot ? `#${shot.objBall.info?.name || shot.objBall.id} (${shot.objBall.info?.type || ''})` : '—');
    set('shot-pocket',  shot ? shot.pocket.label : '—');
    set('shot-score',   shot ? `${shot.score}/100` : '—');
    set('shot-cut',     shot ? `${Math.round(shot.cut)}°` : '—');
    set('shot-candidates', this.bestShots.length > 0 ? `${this.bestShots.length} shots found` : 'No shots');

    const power = shot ? Math.round((shot.suggestedPower || 0) * 100) : 0;
    set('shot-power', shot ? `${power}%` : '—');

    const diffEl = document.getElementById('shot-difficulty');
    if (diffEl) {
      diffEl.textContent = shot?.difficulty?.label || '—';
      diffEl.style.color = shot?.difficulty?.color || '';
    }

    // AR HUD badge
    const badge = document.getElementById('shot-badge');
    if (badge && shot) {
      badge.querySelector('.badge-ball').textContent  = `#${shot.objBall.info?.name || shot.objBall.id}`;
      badge.querySelector('.badge-pocket').textContent = shot.pocket.label;
      badge.querySelector('.badge-diff').textContent  = shot.difficulty?.label || '—';
      badge.querySelector('.badge-diff').style.color  = shot.difficulty?.color || '';
      badge.querySelector('.badge-power').textContent = power ? `⚡${power}%` : '';
    }
  }

  _updateARStatus() {
    const el = document.getElementById('ar-status-badge');
    if (!el) return;
    const s = this.arSession.state;
    const labels = {
      idle:       '○ Off',
      camera:     '◌ Camera',
      tapping:    '⊕ Calibrating',
      calibrated: '● AR Live',
      xr:         '✦ WebXR',
    };
    el.textContent = labels[s] || s;
    el.className   = `ar-status-badge ar-status-${s}`;
  }

  _setStatus(msg) {
    const el = document.getElementById('status-text');
    if (el) el.textContent = msg;
    const arEl = document.getElementById('ar-status-text');
    if (arEl) arEl.textContent = msg;
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
let app;
document.addEventListener('DOMContentLoaded', () => {
  app = new App();
});
