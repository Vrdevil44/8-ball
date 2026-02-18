'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  ARSession – manages camera, WebXR AR, and table calibration.
//
//  Calibration states:
//    'idle'       – nothing started
//    'camera'     – getUserMedia running, no table calibrated
//    'tapping'    – user is tapping the 4 table corners
//    'calibrated' – homography established, AR overlays active
//    'xr'         – WebXR immersive-ar session running
// ═══════════════════════════════════════════════════════════════════════════

class ARSession {
  constructor(videoEl) {
    this.videoEl        = videoEl;
    this.stream         = null;
    this.xrSession      = null;
    this.xrRefSpace     = null;
    this.xrHitTest      = null;
    this.xrDepth        = false;

    // Calibration
    this.state          = 'idle';
    this.corners        = [];          // [{x,y},...] screen-px, 4 points
    this.cornerNames    = ['Top-Left', 'Top-Right', 'Bottom-Right', 'Bottom-Left'];
    this.H              = null;        // 9-element Float64Array: table→screen
    this.lastDepthMap   = null;

    // WebXR plane / hit-test last result
    this.xrTablePose    = null;        // XRPose when table plane was confirmed

    // Callbacks
    this.onCalibrated   = null;        // () => void
    this.onCornerTapped = null;        // (idx, screenPt) => void
    this.onError        = null;        // (msg) => void

    // Off-screen canvas for image processing
    this._offCanvas     = document.createElement('canvas');
    this._offCtx        = this._offCanvas.getContext('2d', { willReadFrequently: true });
  }

  // ── Public API ────────────────────────────────────────────────────────────

  get calibrated() { return this.state === 'calibrated' || this.state === 'xr'; }
  get running()    { return this.state !== 'idle'; }

  async startCamera(facingMode = 'environment') {
    if (this.stream) this.stopCamera();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: facingMode },
          width:      { ideal: 1920 },
          height:     { ideal: 1080 },
        },
        audio: false,
      });
      this.videoEl.srcObject = this.stream;
      await this.videoEl.play();
      this.state = 'camera';
      return true;
    } catch (err) {
      this._emitError(err.name || 'camera-error');
      return false;
    }
  }

  stopCamera() {
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    if (this.xrSession) {
      this.xrSession.end().catch(() => {});
      this.xrSession = null;
    }
    this.state = 'idle';
  }

  // ── WebXR AR session ─────────────────────────────────────────────────────

  static async isXRSupported() {
    return !!(navigator.xr && await navigator.xr.isSessionSupported('immersive-ar').catch(() => false));
  }

  async startXR(overlayRoot) {
    if (!navigator.xr) return false;

    const supported = await navigator.xr.isSessionSupported('immersive-ar').catch(() => false);
    if (!supported) return false;

    const sessionInit = {
      requiredFeatures: ['hit-testing', 'local-floor'],
      optionalFeatures: [],
    };

    // Depth sensing (LiDAR on iPhone Pro)
    const depthOpts = {
      usagePreference:      ['cpu-optimized', 'gpu-optimized'],
      dataFormatPreference: ['luminance-alpha', 'float32'],
    };

    // DOM overlay lets us keep canvas 2D UI on top
    if (overlayRoot) {
      sessionInit.optionalFeatures.push('dom-overlay');
      sessionInit.domOverlay = { root: overlayRoot };
    }
    sessionInit.optionalFeatures.push('depth-sensing', 'light-estimation', 'camera-access');
    sessionInit.depthSensing = depthOpts;

    try {
      this.xrSession = await navigator.xr.requestSession('immersive-ar', sessionInit);

      // We need a WebGL canvas for the XR base layer (even if we draw on 2D canvas)
      const glCanvas = document.createElement('canvas');
      const gl = glCanvas.getContext('webgl', { xrCompatible: true });
      await gl.makeXRCompatible();
      this.xrSession.updateRenderState({
        baseLayer: new XRWebGLLayer(this.xrSession, gl),
      });

      this.xrRefSpace = await this.xrSession.requestReferenceSpace('local-floor')
        .catch(() => this.xrSession.requestReferenceSpace('local'));

      // Hit test source (for table plane detection)
      const viewerSpace = await this.xrSession.requestReferenceSpace('viewer');
      this.xrHitTest = await this.xrSession.requestHitTestSource({ space: viewerSpace })
        .catch(() => null);

      // Check if depth is available
      this.xrDepth = !!(this.xrSession.depthSensing);

      this.state = 'xr';
      this._startXRLoop();
      return true;
    } catch (err) {
      console.warn('WebXR AR unavailable:', err.message);
      return false;
    }
  }

  _startXRLoop() {
    const onFrame = (time, frame) => {
      if (!this.xrSession) return;
      this.xrSession.requestAnimationFrame(onFrame);

      // Hit test results → update table plane estimate
      if (this.xrHitTest) {
        const hits = frame.getHitTestResults(this.xrHitTest);
        if (hits.length > 0) {
          this.xrTablePose = hits[0].getPose(this.xrRefSpace);
        }
      }

      // Depth map (LiDAR) – store last data for detection enhancement
      if (this.xrDepth) {
        const views = frame.getViewerPose(this.xrRefSpace)?.views || [];
        for (const view of views) {
          const depthInfo = frame.getDepthInformation?.(view);
          if (depthInfo) {
            this.lastDepthMap = depthInfo;
            break;
          }
        }
      }
    };
    this.xrSession.requestAnimationFrame(onFrame);
    this.xrSession.addEventListener('end', () => {
      this.xrSession  = null;
      this.xrHitTest  = null;
      this.state = this.stream ? 'camera' : 'idle';
    });
  }

  // ── Table calibration (corner tapping) ──────────────────────────────────

  beginCalibration() {
    this.corners = [];
    this.H       = null;
    this.state   = 'tapping';
  }

  // Call this when user taps on the canvas during calibration
  // screenX, screenY: pixel coordinates on the display canvas
  // Returns the name of the corner just tapped, or null if calibration complete
  tapCorner(screenX, screenY) {
    if (this.state !== 'tapping') return null;
    if (this.corners.length >= 4) return null;

    const name = this.cornerNames[this.corners.length];
    this.corners.push({ x: screenX, y: screenY });
    if (this.onCornerTapped) this.onCornerTapped(this.corners.length - 1, { x: screenX, y: screenY });

    if (this.corners.length === 4) {
      this._computeHomography();
    }
    return name;
  }

  resetCalibration() {
    this.corners = [];
    this.H       = null;
    if (this.state === 'calibrated') this.state = 'camera';
    else if (this.state !== 'xr')   this.state = 'tapping';
  }

  // ── Coordinate transforms (public) ──────────────────────────────────────

  // Table-mm → screen-px
  tableToScreen(tx, ty) {
    if (!this.H) return { x: tx, y: ty };
    return Homography.project(this.H, tx, ty);
  }

  // Screen-px → table-mm
  screenToTable(sx, sy) {
    if (!this.H) return { x: sx, y: sy };
    return Homography.unproject(this.H, sx, sy);
  }

  // ── Camera frame access ──────────────────────────────────────────────────

  // Get a down-scaled ImageData from the current camera frame.
  // scale: 0.25–1.0 (lower = faster)
  getCameraFrame(scale = 0.35) {
    const vw = this.videoEl.videoWidth;
    const vh = this.videoEl.videoHeight;
    if (!vw || !vh) return null;

    const sw = Math.max(1, Math.floor(vw * scale));
    const sh = Math.max(1, Math.floor(vh * scale));
    this._offCanvas.width  = sw;
    this._offCanvas.height = sh;
    this._offCtx.drawImage(this.videoEl, 0, 0, sw, sh);
    return {
      data:  this._offCtx.getImageData(0, 0, sw, sh),
      sw, sh,
      scale,
      vw, vh,
    };
  }

  // Get a full-resolution ImageData (only when needed, expensive)
  getFullFrame() {
    const vw = this.videoEl.videoWidth;
    const vh = this.videoEl.videoHeight;
    if (!vw || !vh) return null;
    this._offCanvas.width  = vw;
    this._offCanvas.height = vh;
    this._offCtx.drawImage(this.videoEl, 0, 0, vw, vh);
    return {
      data: this._offCtx.getImageData(0, 0, vw, vh),
      sw: vw, sh: vh,
      scale: 1,
      vw, vh,
    };
  }

  // Warp the current camera frame into a normalised top-down table view.
  // Returns ImageData of size destW × destH.
  getWarpedTableFrame(destW = 400, destH = 200) {
    if (!this.H) return null;
    const frame = this.getCameraFrame(0.5);
    if (!frame) return null;

    // Build a screen-scaled homography (because frame is at scale, not full res)
    const s = frame.scale;
    const Hs = Float64Array.from(this.H);
    // Scale screen coords: screen_full → screen_scaled means dividing H columns by s
    for (let i = 0; i < 3; i++) {
      Hs[i * 3 + 0] /= s;
      Hs[i * 3 + 1] /= s;
      // Hs[i*3+2] stays (translation in normalised units stays the same only for affine)
    }
    // Re-do properly: scale cols 0,1 and rows 0,1 differently
    // Just re-derive the scaled homography from the scaled corners
    const scaledCorners = this.corners.map(p => ({ x: p.x * s, y: p.y * s }));
    const tablePts = [
      { x: 0,          y: 0           },
      { x: C.TABLE_W,  y: 0           },
      { x: C.TABLE_W,  y: C.TABLE_H  },
      { x: 0,          y: C.TABLE_H  },
    ];
    const Hscaled = Homography.compute(tablePts, scaledCorners);
    if (!Hscaled) return null;

    return Homography.warpToTable(Hscaled, frame.data.data, frame.sw, frame.sh, destW, destH);
  }

  // ── Depth query (LiDAR) ──────────────────────────────────────────────────

  // Get depth at normalised screen coordinates [0,1].
  // Returns depth in metres, or null.
  getDepthAt(normX, normY) {
    if (!this.lastDepthMap) return null;
    try {
      return this.lastDepthMap.getDepthInMeters(normX, normY);
    } catch {
      return null;
    }
  }

  // ── Private ──────────────────────────────────────────────────────────────

  _computeHomography() {
    // Table corners in table-mm: TL, TR, BR, BL
    const tablePts = [
      { x: 0,          y: 0          },
      { x: C.TABLE_W,  y: 0          },
      { x: C.TABLE_W,  y: C.TABLE_H },
      { x: 0,          y: C.TABLE_H },
    ];
    this.H = Homography.compute(tablePts, this.corners);
    if (this.H) {
      this.state = 'calibrated';
      if (this.onCalibrated) this.onCalibrated();
    } else {
      this._emitError('homography-degenerate');
      this.corners = [];
      this.state   = 'tapping';
    }
  }

  _emitError(msg) {
    console.warn('ARSession:', msg);
    if (this.onError) this.onError(msg);
  }
}
