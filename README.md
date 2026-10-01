# 🎱 8-Ball Pool Assistant

A real-time pool coaching web app that runs entirely in the browser — no server, no install, no dependencies. Open the link and you're shooting.

**Live demo:** https://vrdevil44.github.io/8-ball/

## Play it now

The site opens straight into **Demo mode**: a virtual pool table, no camera needed. It works on desktop and mobile.

- **▶ Shoot!** — fire the AI's recommended shot
- **Rack / New** — re-rack the balls or start a fresh game
- **Random** — scatter a random layout (set the ball count)
- **AI: ON/OFF** — toggle the shot-recommendation overlay
- **⚡ slider** — shot power
- **Drag from the cue ball** — aim and shoot manually
- **Tap a ball, then tap a pocket** — see the ghost-ball line for that exact shot
- **☰ panel** — game state, AI recommendation details, balls remaining, training stats

## Features

- **Virtual pool table** with a full 2D 8-ball physics engine — friction (sliding & rolling), cushion bounce (COR 0.75), ball–ball collisions (COR 0.93)
- **Ghost-ball aiming system** — visualises the exact contact point required
- **AI shot recommendation** — scores every possible shot by pocketability, path clearance, position play and scratch risk
- **Full trajectory overlay** — cue-ball path, object-ball path, cushion reflections
- **8-ball game state machine** — break → open table → group assignment → 8-ball phase → win/loss
- **Camera AR mode** (optional, "📷 Start AR") — uses `getUserMedia` + Canvas 2D colour segmentation to detect a real pool table and balls, with cue-stick detection; WebXR supported where available
- **PWA** — installable, works offline after first load (service worker)
- **Training log** — shot history stored locally in IndexedDB, exportable as JSON

## Tech

Vanilla JS + Canvas 2D, no bundler, no frameworks. Load order matters — see the `<script>` tags in `index.html`.

| File | Role |
|---|---|
| `js/app.js` | App controller — demo/AR modes, input, HUD |
| `js/physics.js` | 2D physics simulation |
| `js/gameState.js` | 8-ball rules state machine |
| `js/shotEngine.js` | Ghost-ball math + AI shot scoring |
| `js/renderer.js` | Canvas renderer + table coordinate transforms |
| `js/detection.js` / `js/stickDetector.js` | Camera ball/cue detection |
| `js/arSession.js` / `js/homography.js` | Camera session, calibration, WebXR |
| `js/training.js` | IndexedDB shot log |
| `js/constants.js` | Table dimensions, ball data, vector math |

Deployed via GitHub Pages (Actions workflow, deploys on every push to `main`).

## Controls (demo mode)

| Action | How |
|---|---|
| Shoot AI's best shot | **▶ Shoot!** button |
| Manual aim | Press-drag from the cue ball, release to shoot |
| Pick your own shot | Tap a ball, then tap a pocket |
| Shot power | ⚡ slider (5–100%) |
| New game / re-rack | **New** / **Rack** buttons |
