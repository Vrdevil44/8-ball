'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  StickDetector – detects the pool cue stick in a camera frame
//  and derives its aim direction.
//
//  Algorithm:
//   1. Grayscale + Sobel edge map (fast)
//   2. Accumulator-based line voting (simplified Hough transform)
//   3. Color confirm: samples along candidate line for cue-like HSV
//   4. Tip-end detection: fine end is near brightest (cue-ball) region
//   5. Aim ray: extend stick axis beyond tip → table intersection
//
//  Output:
//    {
//      line:     { x1,y1,x2,y2 },   // full detected stick in screen-px
//      tipPt:    { x,y },           // fine tip end
//      buttPt:   { x,y },           // butt / grip end
//      aimDir:   { x,y },           // normalised direction of aim (tip→target)
//      aimPt:    { x,y },           // estimated table-mm intersection
//      confidence: 0–1
//    }
//    or null if no cue detected.
// ═══════════════════════════════════════════════════════════════════════════

class StickDetector {
  constructor() {
    // Hough params
    this.HOUGH_SCALE  = 0.25;   // process at 1/4 res for speed
    this.NUM_ANGLES   = 180;    // θ resolution
    this.MIN_VOTES    = 40;     // minimum votes for a valid line
    this.TOP_LINES    = 8;      // number of candidate lines to check

    // Cue color acceptance (HSV, h 0-360, s/v 0-255)
    this.CUE_HSV      = { hMin: 10, hMax: 50, sMin: 30, sMax: 220, vMin: 50, vMax: 220 };
    // Dark graphite/black cue fallback
    this.CUE_DARK     = { vMax: 80 };
    // Minimum fraction of line pixels matching cue color
    this.MIN_COLOR_MATCH = 0.30;

    // Minimum and maximum stick length (fraction of image diagonal)
    this.MIN_LEN_FRAC = 0.12;
    this.MAX_LEN_FRAC = 0.95;

    // Persistent state for smoothing
    this._prevResult  = null;
    this._smoothAlpha = 0.4;     // EMA smoothing (0=frozen, 1=raw)

    // Off-screen canvases
    this._smallCanvas = document.createElement('canvas');
    this._smallCtx    = this._smallCanvas.getContext('2d', { willReadFrequently: true });
  }

  // ── Main detect entry point ──────────────────────────────────────────────
  // videoEl or imageData+width+height can be supplied.
  detect(videoEl, arSession) {
    const vw = videoEl.videoWidth;
    const vh = videoEl.videoHeight;
    if (!vw || !vh) return null;

    const sw = Math.floor(vw * this.HOUGH_SCALE);
    const sh = Math.floor(vh * this.HOUGH_SCALE);
    this._smallCanvas.width  = sw;
    this._smallCanvas.height = sh;
    this._smallCtx.drawImage(videoEl, 0, 0, sw, sh);
    const imgData = this._smallCtx.getImageData(0, 0, sw, sh);
    const pixels  = imgData.data;

    // Greyscale + edge detect
    const gray  = this._toGray(pixels, sw, sh);
    const edges = this._sobelEdge(gray, sw, sh);

    // Hough line accumulator
    const lines = this._houghLines(edges, sw, sh);
    if (!lines.length) return null;

    // Filter lines for aspect ratio + color
    const diag = Math.sqrt(sw * sw + sh * sh);
    const minLen = diag * this.MIN_LEN_FRAC;
    const maxLen = diag * this.MAX_LEN_FRAC;

    let best = null;
    for (const L of lines) {
      const seg = this._rhoThetaToSegment(L.rho, L.theta, sw, sh);
      if (!seg) continue;

      const len = Math.sqrt((seg.x2 - seg.x1) ** 2 + (seg.y2 - seg.y1) ** 2);
      if (len < minLen || len > maxLen) continue;

      const colorScore = this._colorScore(seg, pixels, sw, sh);
      if (colorScore < this.MIN_COLOR_MATCH) continue;

      const score = L.votes * colorScore;
      if (!best || score > best.score) {
        best = { ...seg, votes: L.votes, colorScore, score };
      }
    }

    if (!best) return null;

    // Scale back to full-resolution screen coordinates
    const invScale = 1 / this.HOUGH_SCALE;
    const fullSeg = {
      x1: best.x1 * invScale,
      y1: best.y1 * invScale,
      x2: best.x2 * invScale,
      y2: best.y2 * invScale,
    };

    // Find tip (fine end) vs butt (thick/grip end)
    const withEnds = this._findTipEnd(fullSeg, videoEl, vw, vh);

    // Compute aim direction: from tip → forward along stick axis
    const aimDir = this._computeAimDir(withEnds.tipPt, withEnds.buttPt);

    // Project aim ray onto table plane (if AR session is calibrated)
    let aimTablePt = null;
    if (arSession && arSession.calibrated) {
      aimTablePt = this._projectAimOnTable(withEnds.tipPt, aimDir, arSession, vw, vh);
    }

    const confidence = Math.min(1, (best.votes / 200) * (best.colorScore * 2));

    const raw = {
      line:       fullSeg,
      tipPt:      withEnds.tipPt,
      buttPt:     withEnds.buttPt,
      aimDir,
      aimPt:      aimTablePt,
      confidence,
    };

    // Smooth with previous detection
    const result = this._smooth(raw);
    this._prevResult = result;
    return result;
  }

  // ── Grayscale ─────────────────────────────────────────────────────────────
  _toGray(pixels, w, h) {
    const g = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const b = i * 4;
      g[i] = 0.299 * pixels[b] + 0.587 * pixels[b + 1] + 0.114 * pixels[b + 2];
    }
    return g;
  }

  // ── Sobel edge detection ──────────────────────────────────────────────────
  _sobelEdge(gray, w, h) {
    const edges = new Uint8Array(w * h);
    const threshold = 30;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const gx =
          -gray[(y - 1) * w + (x - 1)] + gray[(y - 1) * w + (x + 1)]
          - 2 * gray[y * w + (x - 1)] + 2 * gray[y * w + (x + 1)]
          - gray[(y + 1) * w + (x - 1)] + gray[(y + 1) * w + (x + 1)];
        const gy =
          gray[(y - 1) * w + (x - 1)] + 2 * gray[(y - 1) * w + x] + gray[(y - 1) * w + (x + 1)]
          - gray[(y + 1) * w + (x - 1)] - 2 * gray[(y + 1) * w + x] - gray[(y + 1) * w + (x + 1)];
        const mag = Math.sqrt(gx * gx + gy * gy);
        edges[y * w + x] = mag > threshold ? 255 : 0;
      }
    }
    return edges;
  }

  // ── Hough line accumulator ────────────────────────────────────────────────
  _houghLines(edges, w, h) {
    const numAngles = this.NUM_ANGLES;
    const diagLen   = Math.ceil(Math.sqrt(w * w + h * h));
    const numDists  = diagLen * 2 + 1;
    const accum     = new Int32Array(numAngles * numDists);

    const cosArr = new Float32Array(numAngles);
    const sinArr = new Float32Array(numAngles);
    for (let a = 0; a < numAngles; a++) {
      const theta = a * Math.PI / numAngles;
      cosArr[a] = Math.cos(theta);
      sinArr[a] = Math.sin(theta);
    }

    const cx = w / 2, cy = h / 2;

    // Vote
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!edges[y * w + x]) continue;
        const dx = x - cx, dy = y - cy;
        for (let a = 0; a < numAngles; a++) {
          const rho = Math.round(dx * cosArr[a] + dy * sinArr[a]) + diagLen;
          if (rho >= 0 && rho < numDists) accum[a * numDists + rho]++;
        }
      }
    }

    // Find peaks
    const peaks = [];
    for (let a = 0; a < numAngles; a++) {
      for (let r = 1; r < numDists - 1; r++) {
        const v = accum[a * numDists + r];
        if (v < this.MIN_VOTES) continue;
        if (v < accum[a * numDists + r - 1] || v < accum[a * numDists + r + 1]) continue;
        peaks.push({ rho: r - diagLen, theta: a * Math.PI / numAngles, votes: v });
      }
    }

    // Sort by votes, return top N
    peaks.sort((a, b) => b.votes - a.votes);
    return peaks.slice(0, this.TOP_LINES);
  }

  // ── Convert (rho, theta) to a clipped line segment ────────────────────────
  _rhoThetaToSegment(rho, theta, w, h) {
    const cx = w / 2, cy = h / 2;
    const cosT = Math.cos(theta), sinT = Math.sin(theta);

    // Clip against image rect [0,w)×[0,h)
    const pts = [];
    const addIfIn = (x, y) => {
      if (x >= 0 && x <= w && y >= 0 && y <= h) pts.push({ x, y });
    };

    if (Math.abs(sinT) > 1e-6) {
      // Intersect y=0, y=h
      addIfIn((rho - (0 - cy) * sinT) / cosT + cx, 0);
      addIfIn((rho - (h - cy) * sinT) / cosT + cx, h);
    }
    if (Math.abs(cosT) > 1e-6) {
      // Intersect x=0, x=w
      addIfIn(0, (rho - (0 - cx) * cosT) / sinT + cy);
      addIfIn(w, (rho - (w - cx) * cosT) / sinT + cy);
    }

    if (pts.length < 2) return null;
    const a = pts[0], b = pts[pts.length - 1];
    return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  }

  // ── Color score along segment (fraction of pixels that look like a cue) ──
  _colorScore(seg, pixels, w, h) {
    const steps = 30;
    let match = 0;
    for (let s = 0; s <= steps; s++) {
      const t  = s / steps;
      const px = Math.round(seg.x1 + (seg.x2 - seg.x1) * t);
      const py = Math.round(seg.y1 + (seg.y2 - seg.y1) * t);
      if (px < 0 || px >= w || py < 0 || py >= h) continue;

      const idx = (py * w + px) * 4;
      const r = pixels[idx], g = pixels[idx + 1], b = pixels[idx + 2];
      const { h: hh, s: ss, v: vv } = this._rgbToHsv(r, g, b);

      const woodCue = hh >= this.CUE_HSV.hMin && hh <= this.CUE_HSV.hMax
                   && ss >= this.CUE_HSV.sMin && ss <= this.CUE_HSV.sMax
                   && vv >= this.CUE_HSV.vMin && vv <= this.CUE_HSV.vMax;
      const darkCue = vv <= this.CUE_DARK.vMax;

      if (woodCue || darkCue) match++;
    }
    return match / (steps + 1);
  }

  // ── Find which end is the fine tip ────────────────────────────────────────
  // The tip end is typically:
  //  a) Smaller/narrower (harder to detect from image alone)
  //  b) Closer to the white cue ball
  //  c) More central in the image (player aims from the back)
  _findTipEnd(seg, videoEl, vw, vh) {
    const p1 = { x: seg.x1, y: seg.y1 };
    const p2 = { x: seg.x2, y: seg.y2 };

    // Sample cue-ball whiteness near each end
    const w1 = this._whiteness(p1, videoEl, vw, vh);
    const w2 = this._whiteness(p2, videoEl, vw, vh);

    // Tip is closer to white cue ball
    const tipPt  = w1 > w2 ? p1 : p2;
    const buttPt = w1 > w2 ? p2 : p1;
    return { tipPt, buttPt };
  }

  // Average whiteness in a small neighborhood
  _whiteness(pt, videoEl, vw, vh) {
    const c = this._smallCanvas;
    const ctx = this._smallCtx;
    const s = this.HOUGH_SCALE;
    const r = 8;
    const px = Math.round(pt.x * s), py = Math.round(pt.y * s);
    let total = 0, n = 0;
    const w = Math.floor(vw * s), h = Math.floor(vh * s);
    // Use the already-drawn small canvas
    try {
      const imgD = ctx.getImageData(Math.max(0, px - r), Math.max(0, py - r), r * 2, r * 2);
      const d = imgD.data;
      for (let i = 0; i < d.length; i += 4) {
        total += (d[i] + d[i + 1] + d[i + 2]) / 3;
        n++;
      }
    } catch { return 0; }
    return n > 0 ? total / n : 0;
  }

  // ── Compute aim direction (tip → target, extending past tip) ─────────────
  _computeAimDir(tipPt, buttPt) {
    // Aim direction: from butt through tip and beyond
    const dx = tipPt.x - buttPt.x;
    const dy = tipPt.y - buttPt.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    return { x: dx / len, y: dy / len };
  }

  // ── Project aim ray onto the table plane ─────────────────────────────────
  // In 2D (camera image space), extend the aim ray from tipPt in aimDir and
  // find its intersection with the green felt mask via step marching.
  _projectAimOnTable(tipPt, aimDir, arSession, vw, vh) {
    // March along the ray in screen space and find where it hits the table region
    const maxSteps = 200;
    const step     = 10; // screen-px per step

    for (let i = 1; i <= maxSteps; i++) {
      const sx = tipPt.x + aimDir.x * step * i;
      const sy = tipPt.y + aimDir.y * step * i;

      // Check bounds
      if (sx < 0 || sx > vw || sy < 0 || sy > vh) break;

      // Convert to table coords; valid if inside table region
      const tp = arSession.screenToTable(sx, sy);
      if (tp.x >= 0 && tp.x <= C.TABLE_W && tp.y >= 0 && tp.y <= C.TABLE_H) {
        return tp;
      }
    }
    return null;
  }

  // ── EMA smoothing between frames ─────────────────────────────────────────
  _smooth(raw) {
    if (!this._prevResult) return raw;
    const a = this._smoothAlpha;
    const lerp = (v1, v2) => v1 * (1 - a) + v2 * a;

    return {
      line: {
        x1: lerp(this._prevResult.line.x1, raw.line.x1),
        y1: lerp(this._prevResult.line.y1, raw.line.y1),
        x2: lerp(this._prevResult.line.x2, raw.line.x2),
        y2: lerp(this._prevResult.line.y2, raw.line.y2),
      },
      tipPt:      { x: lerp(this._prevResult.tipPt.x, raw.tipPt.x), y: lerp(this._prevResult.tipPt.y, raw.tipPt.y) },
      buttPt:     { x: lerp(this._prevResult.buttPt.x, raw.buttPt.x), y: lerp(this._prevResult.buttPt.y, raw.buttPt.y) },
      aimDir:     raw.aimDir,
      aimPt:      raw.aimPt,
      confidence: lerp(this._prevResult.confidence, raw.confidence),
    };
  }

  // ── RGB → HSV (h:0-360, s:0-255, v:0-255) ────────────────────────────────
  _rgbToHsv(r, g, b) {
    const rn = r / 255, gn = g / 255, bn = b / 255;
    const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
    const d = max - min;
    let h = 0;
    const s = max === 0 ? 0 : d / max;
    const v = max;
    if (d !== 0) {
      if (max === rn)      h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
      else if (max === gn) h = ((bn - rn) / d + 2) / 6;
      else                 h = ((rn - gn) / d + 4) / 6;
    }
    return { h: h * 360, s: s * 255, v: v * 255 };
  }
}

const stickDetector = new StickDetector();
