'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  Homography – 4-point perspective transform
//  Maps table-mm coordinates ↔ screen-pixel coordinates.
//
//  Usage:
//    const H = Homography.compute(tablePts, screenPts);   // calibrate
//    const {x, y} = Homography.project(H, tableX, tableY);// table→screen
//    const {x, y} = Homography.unproject(H, sx, sy);      // screen→table
// ═══════════════════════════════════════════════════════════════════════════

class Homography {

  // ── Compute H from 4 point correspondences ──────────────────────────────
  // src: [{x,y}, ...] table-mm  (4 points)
  // dst: [{x,y}, ...] screen-px (4 points, same order)
  // Returns a 3×3 matrix as a flat 9-element Float64Array.
  static compute(src, dst) {
    if (src.length < 4 || dst.length < 4) return null;

    // Build 8×9 linear system  A·h = 0  (DLT algorithm)
    const A = [];
    for (let i = 0; i < 4; i++) {
      const x  = src[i].x, y  = src[i].y;
      const X  = dst[i].x, Y  = dst[i].y;
      A.push([-x, -y, -1,  0,  0,  0,  X*x,  X*y,  X]);
      A.push([ 0,  0,  0, -x, -y, -1,  Y*x,  Y*y,  Y]);
    }

    const h = Homography._solve8x9(A);
    if (!h) return null;

    return new Float64Array([
      h[0], h[1], h[2],
      h[3], h[4], h[5],
      h[6], h[7], 1.0,
    ]);
  }

  // ── Project a table point → screen pixels ────────────────────────────────
  static project(H, x, y) {
    if (!H) return { x, y };
    const w = H[6]*x + H[7]*y + H[8];
    if (Math.abs(w) < 1e-10) return { x: 0, y: 0 };
    return {
      x: (H[0]*x + H[1]*y + H[2]) / w,
      y: (H[3]*x + H[4]*y + H[5]) / w,
    };
  }

  // ── Unproject screen pixels → table coordinates ──────────────────────────
  static unproject(H, X, Y) {
    if (!H) return { x: X, y: Y };
    const Hi = Homography._invert3x3(H);
    if (!Hi) return { x: X, y: Y };
    const w = Hi[6]*X + Hi[7]*Y + Hi[8];
    if (Math.abs(w) < 1e-10) return { x: 0, y: 0 };
    return {
      x: (Hi[0]*X + Hi[1]*Y + Hi[2]) / w,
      y: (Hi[3]*X + Hi[4]*Y + Hi[5]) / w,
    };
  }

  // ── Check if screen point falls inside mapped table quad ─────────────────
  static isInsideTable(H, screenX, screenY) {
    const tp = Homography.unproject(H, screenX, screenY);
    return tp.x >= 0 && tp.x <= C.TABLE_W && tp.y >= 0 && tp.y <= C.TABLE_H;
  }

  // ── Convex hull check for the calibration quad ───────────────────────────
  // corners: [{x,y},...] in screen space (4 points, any order)
  static isInsideQuad(corners, px, py) {
    // Sort corners into convex order (clockwise)
    const sorted = Homography._sortConvex(corners);
    for (let i = 0; i < 4; i++) {
      const a = sorted[i];
      const b = sorted[(i + 1) % 4];
      const cross = (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x);
      if (cross > 0) return false;
    }
    return true;
  }

  // ── Solve 8×9 augmented matrix via Gaussian elimination (h[8]=1) ─────────
  static _solve8x9(A) {
    const n  = 8;
    const M  = A.map(r => r.slice());

    for (let col = 0; col < n; col++) {
      // Partial pivoting
      let maxRow = col;
      for (let row = col + 1; row < n; row++) {
        if (Math.abs(M[row][col]) > Math.abs(M[maxRow][col])) maxRow = row;
      }
      [M[col], M[maxRow]] = [M[maxRow], M[col]];

      const pivot = M[col][col];
      if (Math.abs(pivot) < 1e-12) return null;

      const inv = 1 / pivot;
      for (let j = col; j <= n; j++) M[col][j] *= inv;

      for (let row = 0; row < n; row++) {
        if (row === col) continue;
        const factor = M[row][col];
        for (let j = col; j <= n; j++) M[row][j] -= factor * M[col][j];
      }
    }

    return M.map(row => row[n]);
  }

  // ── 3×3 matrix inverse (stored as flat 9-element array) ──────────────────
  static _invert3x3(m) {
    const a = m[0], b = m[1], c = m[2];
    const d = m[3], e = m[4], f = m[5];
    const g = m[6], h = m[7], k = m[8];

    const det = a*(e*k - f*h) - b*(d*k - f*g) + c*(d*h - e*g);
    if (Math.abs(det) < 1e-10) return null;
    const inv = 1 / det;

    return new Float64Array([
      (e*k - f*h)*inv, (c*h - b*k)*inv, (b*f - c*e)*inv,
      (f*g - d*k)*inv, (a*k - c*g)*inv, (c*d - a*f)*inv,
      (d*h - e*g)*inv, (b*g - a*h)*inv, (a*e - b*d)*inv,
    ]);
  }

  // ── Sort 4 corners into clockwise order ──────────────────────────────────
  static _sortConvex(pts) {
    const cx = pts.reduce((s, p) => s + p.x, 0) / 4;
    const cy = pts.reduce((s, p) => s + p.y, 0) / 4;
    return [...pts].sort((a, b) => {
      const aa = Math.atan2(a.y - cy, a.x - cx);
      const ba = Math.atan2(b.y - cy, b.x - cx);
      return aa - ba;
    });
  }

  // ── Warp a full canvas into a normalised top-down table view ─────────────
  // Returns ImageData (destW × destH) containing the warped table.
  // H:     table→screen homography (forward)
  // ctx:   source 2D context (full camera frame)
  // destW: output width  (maps to TABLE_W mm)
  // destH: output height (maps to TABLE_H mm)
  static warpToTable(H, srcImageData, srcW, srcH, destW, destH) {
    const Hi   = Homography._invert3x3(H);
    if (!Hi) return null;

    const out  = new Uint8ClampedArray(destW * destH * 4);
    const src  = srcImageData;

    // For each pixel in destination, sample from source
    const scaleX = C.TABLE_W / destW;
    const scaleY = C.TABLE_H / destH;

    for (let dy = 0; dy < destH; dy++) {
      for (let dx = 0; dx < destW; dx++) {
        // Destination pixel → table-mm
        const tx = dx * scaleX;
        const ty = dy * scaleY;

        // Table-mm → screen-px using forward H
        const w  = H[6]*tx + H[7]*ty + H[8];
        if (Math.abs(w) < 1e-6) continue;
        const sx = (H[0]*tx + H[1]*ty + H[2]) / w;
        const sy = (H[3]*tx + H[4]*ty + H[5]) / w;

        // Bilinear sample
        const sxi = Math.floor(sx), syi = Math.floor(sy);
        if (sxi < 0 || sxi >= srcW - 1 || syi < 0 || syi >= srcH - 1) continue;

        const fr = sx - sxi, ft = sy - syi;
        const i00 = (syi * srcW + sxi) * 4;
        const i10 = (syi * srcW + sxi + 1) * 4;
        const i01 = ((syi + 1) * srcW + sxi) * 4;
        const i11 = ((syi + 1) * srcW + sxi + 1) * 4;

        const oi = (dy * destW + dx) * 4;
        for (let c = 0; c < 3; c++) {
          out[oi + c] = Math.round(
            src[i00 + c] * (1 - fr) * (1 - ft) +
            src[i10 + c] * fr       * (1 - ft) +
            src[i01 + c] * (1 - fr) * ft       +
            src[i11 + c] * fr       * ft
          );
        }
        out[oi + 3] = 255;
      }
    }

    return new ImageData(out, destW, destH);
  }
}
