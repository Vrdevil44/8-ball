'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  Detection module – camera-based table and ball detection
//  All processing runs in the browser via Canvas 2D ImageData.
//  No external libraries required.
// ═══════════════════════════════════════════════════════════════════════════

class CameraDetector {
  constructor() {
    this.offCanvas = document.createElement('canvas');
    this.offCtx    = this.offCanvas.getContext('2d', { willReadFrequently: true });

    // Scale factor for processing (lower = faster, lower accuracy)
    this.SCALE = 0.35;

    // Table felt HSV thresholds (green felt)
    this.TABLE_HSV = {
      hMin: 35, hMax: 90,
      sMin: 45, sMax: 255,
      vMin: 40, vMax: 255,
    };

    // Blue felt alternative
    this.BLUE_HSV = {
      hMin: 90, hMax: 135,
      sMin: 50, sMax: 255,
      vMin: 40, vMax: 255,
    };

    this.feltMode = 'green'; // 'green' | 'blue'

    // Min blob area for a ball (in scaled pixels)
    this.MIN_BALL_AREA = 30;
    this.MAX_BALL_AREA = 2500;

    // Detected table region (bounding box in original coords)
    this.tableRegion = null;
    this.frameCount  = 0;
  }

  setFeltMode(mode) { this.feltMode = mode; }

  // ── Main detect call ─────────────────────────────────────────────────────
  // Returns { tableBounds, balls: Ball[] } or null if no table found.
  detect(videoEl) {
    const vw = videoEl.videoWidth;
    const vh = videoEl.videoHeight;
    if (!vw || !vh) return null;

    const sw = Math.floor(vw * this.SCALE);
    const sh = Math.floor(vh * this.SCALE);

    this.offCanvas.width  = sw;
    this.offCanvas.height = sh;
    this.offCtx.drawImage(videoEl, 0, 0, sw, sh);

    const imgData = this.offCtx.getImageData(0, 0, sw, sh);
    const pixels  = imgData.data;

    // Build masks
    const tableMask = new Uint8Array(sw * sh);
    const ballMask  = new Uint8Array(sw * sh);

    const hsv = this.feltMode === 'blue' ? this.BLUE_HSV : this.TABLE_HSV;

    for (let i = 0; i < sw * sh; i++) {
      const r = pixels[i * 4], g = pixels[i * 4 + 1], b = pixels[i * 4 + 2];
      const { h, s, v } = this._rgbToHsv(r, g, b);

      const isFelt = h >= hsv.hMin && h <= hsv.hMax
                  && s >= hsv.sMin && s <= hsv.sMax
                  && v >= hsv.vMin && v <= hsv.vMax;

      tableMask[i] = isFelt ? 1 : 0;
      ballMask[i]  = isFelt ? 0 : 1;
    }

    // Erode/dilate table mask to remove noise
    this._morphClose(tableMask, sw, sh, 3);

    // Find table bounding box
    const bounds = this._findBoundingBox(tableMask, sw, sh);
    if (!bounds || bounds.area < sw * sh * 0.05) return null;

    // Only look for balls within the table region (with margin)
    const margin = 5;
    const rx = Math.max(0, bounds.x1 - margin);
    const ry = Math.max(0, bounds.y1 - margin);
    const rw = Math.min(sw - rx, bounds.x2 - bounds.x1 + margin * 2);
    const rh = Math.min(sh - ry, bounds.y2 - bounds.y1 + margin * 2);

    // Restrict ball search inside table
    const restrictedBallMask = new Uint8Array(sw * sh);
    for (let y = ry; y < ry + rh; y++) {
      for (let x = rx; x < rx + rw; x++) {
        const i = y * sw + x;
        if (tableMask[i] === 0 && ballMask[i] === 1) {
          restrictedBallMask[i] = 1;
        }
      }
    }

    // Find ball blobs
    const blobs = this._findBlobs(restrictedBallMask, sw, sh, pixels);

    // Convert blobs to Ball objects
    const detectedBalls = this._blobsToBalls(blobs, vw / sw);

    // Convert table bounds back to original resolution
    const scale = 1 / this.SCALE;
    const tableBounds = {
      x:  bounds.x1 * scale,
      y:  bounds.y1 * scale,
      w:  (bounds.x2 - bounds.x1) * scale,
      h:  (bounds.y2 - bounds.y1) * scale,
    };

    this.tableRegion = tableBounds;
    this.frameCount++;

    return { tableBounds, balls: detectedBalls };
  }

  // ── RGB to HSV (h: 0-180 OpenCV-like scaled, s: 0-255, v: 0-255) ────────
  _rgbToHsv(r, g, b) {
    const rn = r / 255, gn = g / 255, bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const d   = max - min;

    let h = 0;
    const s = max === 0 ? 0 : d / max;
    const v = max;

    if (d !== 0) {
      if (max === rn)      h = (gn - bn) / d + (gn < bn ? 6 : 0);
      else if (max === gn) h = (bn - rn) / d + 2;
      else                  h = (rn - gn) / d + 4;
      h /= 6;
    }

    return { h: h * 360, s: s * 255, v: v * 255 };
  }

  // ── Simple morphological close (dilate then erode) ───────────────────────
  _morphClose(mask, w, h, r) {
    const tmp = new Uint8Array(w * h);
    // Dilate
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (mask[y * w + x] !== 1) continue;
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx >= 0 && nx < w && ny >= 0 && ny < h) tmp[ny * w + nx] = 1;
          }
        }
      }
    }
    // Erode back
    for (let y = r; y < h - r; y++) {
      for (let x = r; x < w - r; x++) {
        if (tmp[y * w + x] !== 1) { mask[y * w + x] = 0; continue; }
        let ok = true;
        for (let dy = -r; dy <= r && ok; dy++) {
          for (let dx = -r; dx <= r && ok; dx++) {
            if (tmp[(y + dy) * w + (x + dx)] !== 1) ok = false;
          }
        }
        mask[y * w + x] = ok ? 1 : 0;
      }
    }
  }

  // ── Bounding box of the largest region ──────────────────────────────────
  _findBoundingBox(mask, w, h) {
    let x1 = w, y1 = h, x2 = 0, y2 = 0, area = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (mask[y * w + x]) {
          x1 = Math.min(x1, x);
          y1 = Math.min(y1, y);
          x2 = Math.max(x2, x);
          y2 = Math.max(y2, y);
          area++;
        }
      }
    }
    if (area === 0) return null;
    return { x1, y1, x2, y2, area };
  }

  // ── BFS blob finder ──────────────────────────────────────────────────────
  _findBlobs(mask, w, h, pixels) {
    const labels = new Int32Array(w * h).fill(-1);
    const blobs  = [];

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        if (!mask[idx] || labels[idx] !== -1) continue;

        // BFS
        const queue = [idx];
        labels[idx] = blobs.length;
        let sumX = 0, sumY = 0, area = 0;
        let minX = x, maxX = x, minY = y, maxY = y;
        let rSum = 0, gSum = 0, bSum = 0;

        let qi = 0;
        while (qi < queue.length) {
          const ci = queue[qi++];
          const cx = ci % w, cy = Math.floor(ci / w);
          area++;
          sumX += cx; sumY += cy;
          minX = Math.min(minX, cx); maxX = Math.max(maxX, cx);
          minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
          rSum += pixels[ci * 4]; gSum += pixels[ci * 4 + 1]; bSum += pixels[ci * 4 + 2];

          const neighbors = [ci - 1, ci + 1, ci - w, ci + w];
          for (const ni of neighbors) {
            if (ni < 0 || ni >= w * h) continue;
            if (!mask[ni] || labels[ni] !== -1) continue;
            labels[ni] = blobs.length;
            queue.push(ni);
          }
        }

        if (area >= this.MIN_BALL_AREA && area <= this.MAX_BALL_AREA) {
          blobs.push({
            cx:   sumX / area,
            cy:   sumY / area,
            area,
            minX, maxX, minY, maxY,
            r:    rSum / area,
            g:    gSum / area,
            b:    bSum / area,
          });
        }
      }
    }

    return blobs;
  }

  // ── Convert blobs to Ball instances ─────────────────────────────────────
  _blobsToBalls(blobs, invScale) {
    const balls = [];
    const usedIds = new Set();

    // Sort by x-position for stable IDs
    blobs.sort((a, b) => a.cx - b.cx);

    for (const blob of blobs) {
      const bw = blob.maxX - blob.minX;
      const bh = blob.maxY - blob.minY;
      // Aspect ratio filter
      const aspect = Math.max(bw, bh) / (Math.min(bw, bh) + 1);
      if (aspect > 2.5) continue;

      // Classify by color
      const ballId = this._classifyColor(blob.r, blob.g, blob.b, usedIds);
      if (ballId < 0) continue;
      usedIds.add(ballId);

      const ball = new Ball(ballId, blob.cx * invScale, blob.cy * invScale);
      balls.push(ball);
    }

    return balls;
  }

  // ── Classify a detected blob as a ball id 0-15 ──────────────────────────
  _classifyColor(r, g, b, usedIds) {
    const { h, s, v } = this._rgbToHsv(r, g, b);

    // Cue ball: near white
    if (s < 35 && v > 190) {
      return usedIds.has(0) ? -1 : 0;
    }

    // 8-ball: near black
    if (v < 60) {
      return usedIds.has(8) ? -1 : 8;
    }

    // Determine stripe vs solid by white content of blob
    // High v with low s segments = likely stripe (approximation)
    const isStripe = (v > 170 && s < 80); // rough heuristic

    // Map hue to base ball number (1-7)
    let base = -1;
    if (h >= 20  && h <= 42)  base = 1; // Yellow
    if (h >= 98  && h <= 135) base = 2; // Blue
    if ((h >= 0 && h <= 12) || (h >= 165 && h <= 180)) base = 3; // Red
    if (h >= 260 && h <= 310) base = 4; // Purple (in 0-360 range)
    if (h >= 13  && h <= 25)  base = 5; // Orange
    if (h >= 80  && h <= 98)  base = 6; // Green
    if (h >= 300 && h <= 340) base = 7; // Maroon/Pink

    if (base < 0) return -1;

    const id = isStripe ? base + 8 : base;
    return usedIds.has(id) ? -1 : id;
  }
}

// ── Camera management ────────────────────────────────────────────────────────

class CameraManager {
  constructor() {
    this.stream     = null;
    this.active     = false;
    this.detector   = new CameraDetector();
    this.onDetect   = null; // callback(result)
    this._interval  = null;
  }

  async start(videoEl) {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width:  { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
      videoEl.srcObject = this.stream;
      await videoEl.play();
      this.active = true;
      this._startDetection(videoEl);
      return true;
    } catch (err) {
      console.warn('Camera access denied or unavailable:', err);
      return false;
    }
  }

  stop() {
    if (this._interval) clearInterval(this._interval);
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    this.active = false;
  }

  _startDetection(videoEl) {
    // Run detection at ~8 fps (fast enough for pool)
    this._interval = setInterval(() => {
      if (!this.active) return;
      const result = this.detector.detect(videoEl);
      if (this.onDetect) this.onDetect(result);
    }, 125);
  }

  setFeltMode(mode) { this.detector.setFeltMode(mode); }
}
