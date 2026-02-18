'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  BallTracker – post-shot real-time ball motion tracking.
//
//  Approach:
//   1. Capture a "reference frame" just before the shot lands.
//   2. On each subsequent frame, compute pixel-wise difference.
//   3. Find blob centroids in the difference map → moving ball positions.
//   4. Assign moving blobs to known ball positions by nearest-neighbour.
//   5. Detect when motion stops (delta falls below threshold).
//   6. Emit 'update' events with new estimated positions.
//   7. Emit 'done' event with final positions.
//
//  All coordinates are in table-mm (requires ARSession to be calibrated).
// ═══════════════════════════════════════════════════════════════════════════

class BallTracker {
  constructor() {
    this.active       = false;
    this.refFrame     = null;      // reference ImageData (scaled)
    this.prevFrame    = null;
    this.refScale     = 0.3;       // process at 30% res
    this.ballStates   = [];        // [{id, x, y, moving}]
    this.frameCount   = 0;
    this.quietFrames  = 0;
    this.QUIET_THRESH = 8;         // frames with low motion = stopped
    this.DIFF_THRESH  = 18;        // per-pixel diff threshold

    // Min/max area for a moving blob to count as a ball
    this.MIN_BLOB     = 20;
    this.MAX_BLOB     = 3000;

    // Callbacks
    this.onUpdate = null;          // (ballStates) => void
    this.onDone   = null;          // (finalStates) => void

    // Off-screen canvas
    this._canvas = document.createElement('canvas');
    this._ctx    = this._canvas.getContext('2d', { willReadFrequently: true });
  }

  // ── Start tracking ────────────────────────────────────────────────────────
  // videoEl:   live camera feed
  // arSession: for coordinate transforms
  // initBalls: [{id, x, y, pocketed}] – current ball positions in table-mm
  start(videoEl, arSession, initBalls) {
    this.active      = true;
    this.frameCount  = 0;
    this.quietFrames = 0;
    this.arSession   = arSession;
    this.videoEl     = videoEl;

    // Clone initial states
    this.ballStates = initBalls.map(b => ({ ...b, moving: false, screenPt: null }));

    // Capture reference frame
    this.refFrame = this._captureFrame();

    // Start frame polling
    this._rafId = requestAnimationFrame(this._loop.bind(this));
  }

  // ── Stop tracking early ───────────────────────────────────────────────────
  stop() {
    this.active = false;
    if (this._rafId) cancelAnimationFrame(this._rafId);
  }

  // ── Frame loop ────────────────────────────────────────────────────────────
  _loop() {
    if (!this.active) return;
    this._processFrame();
    this._rafId = requestAnimationFrame(this._loop.bind(this));
  }

  _processFrame() {
    const frame = this._captureFrame();
    if (!frame || !this.refFrame) return;

    // Compute diff against reference
    const { diffMap, totalDiff } = this._diff(this.refFrame, frame);

    const motionMean = totalDiff / (frame.sw * frame.sh);

    if (motionMean < 2) {
      this.quietFrames++;
    } else {
      this.quietFrames = 0;
      // Find moving blobs
      const blobs = this._findBlobs(diffMap, frame.sw, frame.sh);
      this._updateBallStates(blobs, frame);
      if (this.onUpdate) this.onUpdate([...this.ballStates]);
    }

    this.prevFrame = frame;
    this.frameCount++;

    // Stop if quiet for enough frames, or max frames exceeded
    if (this.quietFrames >= this.QUIET_THRESH || this.frameCount > 600) {
      this._finish();
    }
  }

  // ── Capture a scaled frame ────────────────────────────────────────────────
  _captureFrame() {
    const vw = this.videoEl.videoWidth;
    const vh = this.videoEl.videoHeight;
    if (!vw || !vh) return null;

    const sw = Math.floor(vw * this.refScale);
    const sh = Math.floor(vh * this.refScale);
    this._canvas.width  = sw;
    this._canvas.height = sh;
    this._ctx.drawImage(this.videoEl, 0, 0, sw, sh);
    return {
      data: this._ctx.getImageData(0, 0, sw, sh),
      sw, sh,
    };
  }

  // ── Pixel-wise diff ───────────────────────────────────────────────────────
  _diff(ref, cur) {
    const n    = ref.sw * ref.sh;
    const map  = new Uint8Array(n);
    const rp   = ref.data.data;
    const cp   = cur.data.data;
    let total  = 0;

    for (let i = 0; i < n; i++) {
      const b = i * 4;
      const d = (Math.abs(rp[b] - cp[b]) + Math.abs(rp[b+1] - cp[b+1]) + Math.abs(rp[b+2] - cp[b+2])) / 3;
      total += d;
      map[i] = d > this.DIFF_THRESH ? 1 : 0;
    }

    return { diffMap: map, totalDiff: total };
  }

  // ── Connected-component blob finder ──────────────────────────────────────
  _findBlobs(mask, w, h) {
    const labels = new Int32Array(w * h).fill(-1);
    const blobs  = [];

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        if (!mask[idx] || labels[idx] !== -1) continue;

        const queue = [idx];
        labels[idx] = blobs.length;
        let sx = 0, sy = 0, area = 0;
        let qi = 0;

        while (qi < queue.length) {
          const ci = queue[qi++];
          const cx = ci % w, cy = Math.floor(ci / w);
          sx += cx; sy += cy; area++;

          for (const ni of [ci - 1, ci + 1, ci - w, ci + w]) {
            if (ni < 0 || ni >= w * h) continue;
            if (!mask[ni] || labels[ni] !== -1) continue;
            labels[ni] = blobs.length;
            queue.push(ni);
          }
        }

        if (area >= this.MIN_BLOB && area <= this.MAX_BLOB) {
          blobs.push({ cx: sx / area, cy: sy / area, area });
        }
      }
    }

    return blobs;
  }

  // ── Assign blobs to ball states ───────────────────────────────────────────
  _updateBallStates(blobs, frame) {
    if (!this.arSession?.calibrated) return;
    const invS  = 1 / this.refScale;

    // Convert each blob from scaled-screen to table coords
    const blobTable = blobs.map(b => {
      const sx = b.cx * invS;
      const sy = b.cy * invS;
      const tp = this.arSession.screenToTable(sx, sy);
      return { ...b, tx: tp.x, ty: tp.y };
    });

    // For each ball, find closest blob and update position
    for (const bs of this.ballStates) {
      if (bs.pocketed) { bs.moving = false; continue; }

      let minDist = C.BALL_R * 6;
      let closest = null;
      for (const bt of blobTable) {
        const d = Math.hypot(bt.tx - bs.x, bt.ty - bs.y);
        if (d < minDist) { minDist = d; closest = bt; }
      }

      if (closest) {
        bs.x      = closest.tx;
        bs.y      = closest.ty;
        bs.moving = true;
      } else {
        bs.moving = false;
      }
    }
  }

  // ── Finish and emit done ──────────────────────────────────────────────────
  _finish() {
    this.active = false;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    if (this.onDone) this.onDone([...this.ballStates]);
  }
}
