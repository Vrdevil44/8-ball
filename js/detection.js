'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  CameraDetector – detects the pool table, balls, and cue stick from
//  the camera feed.  When ARSession is calibrated (homography set), it uses
//  a perspective-corrected top-down view for much better accuracy.
//
//  Returns:
//   {
//     tableBounds:  {x, y, w, h}  screen-px bounding box of detected table
//     balls:        Ball[]         detected balls in table-mm coords
//     stick:        StickResult | null
//     confidence:   0-1
//   }
// ═══════════════════════════════════════════════════════════════════════════

class CameraDetector {
  constructor() {
    // Off-screen canvas for processing
    this._offCanvas = document.createElement('canvas');
    this._offCtx    = this._offCanvas.getContext('2d', { willReadFrequently: true });

    // Warped table canvas (top-down view after homography)
    this._warpCanvas = document.createElement('canvas');
    this._warpCtx   = this._warpCanvas.getContext('2d', { willReadFrequently: true });

    // Processing scale for raw detection (before homography)
    this.SCALE = 0.35;

    // Table felt HSV thresholds (h: 0-360, s/v: 0-255)
    this.FELT = {
      green: { hMin: 70,  hMax: 170, sMin: 40, sMax: 255, vMin: 35, vMax: 255 },
      blue:  { hMin: 175, hMax: 265, sMin: 50, sMax: 255, vMin: 35, vMax: 255 },
      tan:   { hMin: 25,  hMax: 55,  sMin: 30, sMax: 200, vMin: 80, vMax: 220 },
    };
    this.feltMode = 'green';

    // Ball blob size in warped-image pixels (at destW=400, destH=200 warp)
    // 400px = 2540mm → scale = 400/2540 px/mm, ball radius 28.575mm → ~4.5px
    this.WARP_W    = 400;
    this.WARP_H    = 200;
    this.WARP_BALL_MIN = 10;  // pixels² area
    this.WARP_BALL_MAX = 1000;

    // Without homography (raw detection)
    this.RAW_BALL_MIN = 30;
    this.RAW_BALL_MAX = 2500;

    // Confidence tracking
    this._frameCount  = 0;
    this._goodFrames  = 0;
    this._stickDet    = typeof stickDetector !== 'undefined' ? stickDetector : null;
  }

  setFeltMode(mode) {
    if (this.FELT[mode]) this.feltMode = mode;
  }

  // ── Main detect call ─────────────────────────────────────────────────────
  // arSession: ARSession instance (may be null or uncalibrated)
  // videoEl:   live <video> element
  detect(videoEl, arSession = null) {
    const vw = videoEl.videoWidth;
    const vh = videoEl.videoHeight;
    if (!vw || !vh) return null;

    this._frameCount++;

    let result;
    if (arSession?.calibrated) {
      result = this._detectCalibrated(videoEl, arSession, vw, vh);
    } else {
      result = this._detectRaw(videoEl, vw, vh);
    }

    // Detect cue stick (always in screen space)
    let stick = null;
    if (this._stickDet) {
      stick = this._stickDet.detect(videoEl, arSession);
    }
    if (result) result.stick = stick;

    // Track confidence
    if (result && result.balls.length > 0) this._goodFrames++;
    const confidence = this._goodFrames / Math.max(1, this._frameCount);

    if (result) result.confidence = Math.min(1, confidence * 3);
    return result;
  }

  // ── Calibrated detection (uses homography + warped top-down view) ─────────
  _detectCalibrated(videoEl, arSession, vw, vh) {
    // Get a top-down warped view of the table
    const warpedData = arSession.getWarpedTableFrame(this.WARP_W, this.WARP_H);
    if (!warpedData) return this._detectRaw(videoEl, vw, vh);

    const pixels = warpedData.data;
    const w = this.WARP_W, h = this.WARP_H;

    // Build ball mask (non-felt pixels inside the warped table)
    const feltHsv = this.FELT[this.feltMode];
    const ballMask = new Uint8Array(w * h);

    for (let i = 0; i < w * h; i++) {
      const b = i * 4;
      const { h: hh, s, v } = this._rgbToHsv(pixels[b], pixels[b+1], pixels[b+2]);
      const isFelt = hh >= feltHsv.hMin && hh <= feltHsv.hMax
                  && s  >= feltHsv.sMin && s  <= feltHsv.sMax
                  && v  >= feltHsv.vMin && v  <= feltHsv.vMax;
      ballMask[i] = isFelt ? 0 : 1;
    }

    // Morphological open to remove tiny noise
    this._morphOpen(ballMask, w, h, 1);

    // Find blobs
    const blobs = this._findBlobs(ballMask, w, h, pixels, this.WARP_BALL_MIN, this.WARP_BALL_MAX);

    // Convert from warped-image coords to table-mm coords
    const scaleX = C.TABLE_W / w;
    const scaleY = C.TABLE_H / h;
    const balls  = this._blobsToBalls(blobs, scaleX, scaleY);

    // Table bounds from calibration corners (in screen space)
    const corners = arSession.corners;
    const xs = corners.map(p => p.x), ys = corners.map(p => p.y);
    const tableBounds = {
      x: Math.min(...xs), y: Math.min(...ys),
      w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys),
    };

    return { tableBounds, balls };
  }

  // ── Raw detection (no calibration – uses HSV on full camera frame) ────────
  _detectRaw(videoEl, vw, vh) {
    const sw = Math.floor(vw * this.SCALE);
    const sh = Math.floor(vh * this.SCALE);
    this._offCanvas.width  = sw;
    this._offCanvas.height = sh;
    this._offCtx.drawImage(videoEl, 0, 0, sw, sh);
    const imgData = this._offCtx.getImageData(0, 0, sw, sh);
    const pixels  = imgData.data;

    const feltHsv = this.FELT[this.feltMode];
    const tableMask = new Uint8Array(sw * sh);
    const ballMask  = new Uint8Array(sw * sh);

    for (let i = 0; i < sw * sh; i++) {
      const b = i * 4;
      const { h, s, v } = this._rgbToHsv(pixels[b], pixels[b+1], pixels[b+2]);
      const isFelt = h >= feltHsv.hMin && h <= feltHsv.hMax
                  && s >= feltHsv.sMin && s <= feltHsv.sMax
                  && v >= feltHsv.vMin && v <= feltHsv.vMax;
      tableMask[i] = isFelt ? 1 : 0;
      ballMask[i]  = isFelt ? 0 : 1;
    }

    this._morphClose(tableMask, sw, sh, 3);

    const bounds = this._findBoundingBox(tableMask, sw, sh);
    if (!bounds || bounds.area < sw * sh * 0.03) return null;

    // Restrict ball search inside table bounds
    const margin = 5;
    const rx = Math.max(0, bounds.x1 - margin);
    const ry = Math.max(0, bounds.y1 - margin);
    const rw = Math.min(sw - rx, bounds.x2 - bounds.x1 + margin * 2);
    const rh = Math.min(sh - ry, bounds.y2 - bounds.y1 + margin * 2);

    const restricBall = new Uint8Array(sw * sh);
    for (let y = ry; y < ry + rh; y++) {
      for (let x = rx; x < rx + rw; x++) {
        const i = y * sw + x;
        if (!tableMask[i] && ballMask[i]) restricBall[i] = 1;
      }
    }

    const blobs = this._findBlobs(restricBall, sw, sh, pixels, this.RAW_BALL_MIN, this.RAW_BALL_MAX);

    // Map blobs from scaled screen → table-mm using table bounding box
    const tableW = (bounds.x2 - bounds.x1) / this.SCALE;
    const tableH = (bounds.y2 - bounds.y1) / this.SCALE;
    const scaleX = C.TABLE_W / Math.max(1, tableW);
    const scaleY = C.TABLE_H / Math.max(1, tableH);
    const offX   = bounds.x1 / this.SCALE;
    const offY   = bounds.y1 / this.SCALE;

    // Build balls with offset
    const balls = this._blobsToBallsRaw(blobs, this.SCALE, offX, offY, scaleX, scaleY);

    const invScale = 1 / this.SCALE;
    const tableBounds = {
      x: bounds.x1 * invScale, y: bounds.y1 * invScale,
      w: (bounds.x2 - bounds.x1) * invScale,
      h: (bounds.y2 - bounds.y1) * invScale,
    };

    return { tableBounds, balls };
  }

  // ── Blob finder with BFS ─────────────────────────────────────────────────
  _findBlobs(mask, w, h, pixels, minArea, maxArea) {
    const labels = new Int32Array(w * h).fill(-1);
    const blobs  = [];

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        if (!mask[idx] || labels[idx] !== -1) continue;

        const queue = [idx];
        labels[idx] = blobs.length;
        let sx = 0, sy = 0, area = 0;
        let rS = 0, gS = 0, bS = 0;
        let minX = x, maxX = x, minY = y, maxY = y;
        let qi = 0;

        while (qi < queue.length) {
          const ci = queue[qi++];
          const cx = ci % w, cy = Math.floor(ci / w);
          area++; sx += cx; sy += cy;
          minX = Math.min(minX, cx); maxX = Math.max(maxX, cx);
          minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
          rS += pixels[ci*4]; gS += pixels[ci*4+1]; bS += pixels[ci*4+2];

          for (const ni of [ci-1, ci+1, ci-w, ci+w]) {
            if (ni < 0 || ni >= w * h) continue;
            if (!mask[ni] || labels[ni] !== -1) continue;
            labels[ni] = blobs.length;
            queue.push(ni);
          }
        }

        if (area >= minArea && area <= maxArea) {
          const bw = maxX - minX, bh = maxY - minY;
          const aspect = Math.max(bw, bh) / (Math.min(bw, bh) + 1);
          if (aspect > 3) continue; // too elongated → not a ball

          blobs.push({ cx: sx/area, cy: sy/area, area,
                       r: rS/area, g: gS/area, b: bS/area,
                       minX, maxX, minY, maxY });
        }
      }
    }
    return blobs;
  }

  // ── Convert warped-image blobs to Ball objects ────────────────────────────
  _blobsToBalls(blobs, scaleX, scaleY) {
    const balls   = [];
    const usedIds = new Set();
    blobs.sort((a, b) => a.cx - b.cx);

    for (const blob of blobs) {
      const id = this._classifyColor(blob.r, blob.g, blob.b, usedIds);
      if (id < 0) continue;
      usedIds.add(id);
      balls.push(new Ball(id, blob.cx * scaleX, blob.cy * scaleY));
    }
    return balls;
  }

  // ── Convert raw blobs to Ball objects (with offset) ───────────────────────
  _blobsToBallsRaw(blobs, scale, offX, offY, scaleX, scaleY) {
    const balls   = [];
    const usedIds = new Set();
    const invS    = 1 / scale;
    blobs.sort((a, b) => a.cx - b.cx);

    for (const blob of blobs) {
      const id = this._classifyColor(blob.r, blob.g, blob.b, usedIds);
      if (id < 0) continue;
      usedIds.add(id);
      const screenX = blob.cx * invS;
      const screenY = blob.cy * invS;
      const tx = (screenX - offX) * scaleX;
      const ty = (screenY - offY) * scaleY;
      balls.push(new Ball(id, tx, ty));
    }
    return balls;
  }

  // ── Color classification → ball id 0-15 ──────────────────────────────────
  _classifyColor(r, g, b, usedIds) {
    const { h, s, v } = this._rgbToHsv(r, g, b);

    // Cue ball: high brightness, low saturation
    if (s < 40 && v > 185) return usedIds.has(0) ? -1 : 0;

    // 8-ball: very dark
    if (v < 60 && s < 120) return usedIds.has(8) ? -1 : 8;

    // Striped: mixed white and color → stripe heuristic
    const isStripe = v > 165 && s < 90;

    // Map hue to base ball number 1-7
    let base = -1;
    if (h >= 42  && h <= 75)  base = 1; // Yellow
    if (h >= 195 && h <= 260) base = 2; // Blue
    if ((h >= 0 && h <= 22) || h >= 338) base = 3; // Red
    if (h >= 262 && h <= 315) base = 4; // Purple
    if (h >= 22  && h <= 42)  base = 5; // Orange
    if (h >= 85  && h <= 155) base = 6; // Green
    if (h >= 315 && h <= 338) base = 7; // Maroon
    if (base < 0) return -1;

    const id = isStripe ? base + 8 : base;
    return usedIds.has(id) ? -1 : id;
  }

  // ── Morphological operations ─────────────────────────────────────────────
  _morphClose(mask, w, h, r) {
    const tmp = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (!mask[y*w+x]) continue;
        for (let dy = -r; dy <= r; dy++)
          for (let dx = -r; dx <= r; dx++) {
            const nx = x+dx, ny = y+dy;
            if (nx>=0&&nx<w&&ny>=0&&ny<h) tmp[ny*w+nx]=1;
          }
      }
    for (let y = r; y < h-r; y++)
      for (let x = r; x < w-r; x++) {
        if (!tmp[y*w+x]) { mask[y*w+x]=0; continue; }
        let ok = true;
        for (let dy=-r; dy<=r&&ok; dy++)
          for (let dx=-r; dx<=r&&ok; dx++)
            if (!tmp[(y+dy)*w+(x+dx)]) ok=false;
        mask[y*w+x] = ok ? 1 : 0;
      }
  }

  _morphOpen(mask, w, h, r) {
    // Erode then dilate
    const tmp = new Uint8Array(w * h);
    for (let y = r; y < h-r; y++)
      for (let x = r; x < w-r; x++) {
        let ok = true;
        for (let dy=-r; dy<=r&&ok; dy++)
          for (let dx=-r; dx<=r&&ok; dx++)
            if (!mask[(y+dy)*w+(x+dx)]) ok=false;
        tmp[y*w+x] = ok ? 1 : 0;
      }
    mask.set(tmp);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (!mask[y*w+x]) continue;
        for (let dy=-r; dy<=r; dy++)
          for (let dx=-r; dx<=r; dx++) {
            const nx=x+dx, ny=y+dy;
            if (nx>=0&&nx<w&&ny>=0&&ny<h) tmp[ny*w+nx]=1;
          }
      }
    mask.set(tmp);
  }

  // ── Table bounding box ────────────────────────────────────────────────────
  _findBoundingBox(mask, w, h) {
    let x1=w, y1=h, x2=0, y2=0, area=0;
    for (let y=0;y<h;y++)
      for (let x=0;x<w;x++)
        if (mask[y*w+x]) { x1=Math.min(x1,x); y1=Math.min(y1,y); x2=Math.max(x2,x); y2=Math.max(y2,y); area++; }
    if (!area) return null;
    return { x1, y1, x2, y2, area };
  }

  // ── RGB → HSV ─────────────────────────────────────────────────────────────
  _rgbToHsv(r, g, b) {
    const rn=r/255, gn=g/255, bn=b/255;
    const max=Math.max(rn,gn,bn), min=Math.min(rn,gn,bn);
    const d=max-min;
    let h=0;
    const s=max===0?0:d/max, v=max;
    if (d!==0) {
      if (max===rn)       h=((gn-bn)/d+(gn<bn?6:0))/6;
      else if (max===gn)  h=((bn-rn)/d+2)/6;
      else                h=((rn-gn)/d+4)/6;
    }
    return { h: h*360, s: s*255, v: v*255 };
  }
}

// ── Camera manager ────────────────────────────────────────────────────────────

class CameraManager {
  constructor() {
    this.detector   = new CameraDetector();
    this.onDetect   = null;    // callback(result)
    this._interval  = null;
    this._arSession = null;
  }

  setARSession(arSession) { this._arSession = arSession; }
  setFeltMode(mode)       { this.detector.setFeltMode(mode); }

  startDetection(videoEl, fps = 8) {
    if (this._interval) clearInterval(this._interval);
    this._interval = setInterval(() => {
      if (!videoEl.videoWidth) return;
      const result = this.detector.detect(videoEl, this._arSession);
      if (this.onDetect) this.onDetect(result);
    }, Math.round(1000 / fps));
  }

  stopDetection() {
    if (this._interval) clearInterval(this._interval);
    this._interval = null;
  }
}
