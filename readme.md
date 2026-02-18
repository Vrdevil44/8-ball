# 8-Ball AR Pool Assistant

A real-time AR pool coaching web app that runs entirely in the browser — no server, no install, no dependencies.

## Live Demo
> Deployed via GitHub Pages from the `claude/deploy-github-pages-hwSvc` branch.

## Features
- **Virtual pool table** with a full 8-ball physics engine
- **Ghost-ball aiming system** – visualises the exact contact point required
- **AI shot recommendation** – scores every possible shot by pocketability, path clearance, position play and scratch risk
- **Full trajectory overlay** – cue-ball path, object-ball path, cushion reflections
- **Physics simulation** – friction (sliding & rolling), cushion bounce (COR 0.75), ball-ball collisions (COR 0.93)
- **8-ball game state machine** – open table → group assignment → 8-ball phase → win/loss
- **Camera AR mode** – uses `getUserMedia` + Canvas 2D colour segmentation to detect a real pool table and balls
- **Responsive** – works on desktop and mobile browsers (portrait & landscape)

## How It Works

### No Build Step Required
The app is pure HTML + CSS + JavaScript. GitHub Pages serves the static files directly from the repository root. No Node.js, no npm, no bundler.

### Deployment
A GitHub Actions workflow (`.github/workflows/deploy.yml`) automatically deploys to GitHub Pages on every push to the branch.

**To enable GitHub Pages in the repository settings:**
1. Go to **Settings → Pages**
2. Set source to **GitHub Actions**
3. The workflow will handle the rest on the next push

### Browser Requirements
| Feature | Required |
|---|---|
| Canvas 2D | All modern browsers |
| `getUserMedia` | Camera mode only |
| `requestAnimationFrame` | All modern browsers |
| ES2020 | Chrome 80+, Firefox 74+, Safari 13.1+ |

## Project Structure
```
├── index.html              # App shell (single page)
├── css/
│   └── style.css           # Dark gaming UI, responsive
├── js/
│   ├── constants.js        # Physics constants, ball data, pocket positions
│   ├── physics.js          # Fixed-timestep physics simulation
│   ├── gameState.js        # 8-ball game state machine + ball layouts
│   ├── shotEngine.js       # Ghost ball, trajectory prediction, AI scoring
│   ├── detection.js        # Camera-based table & ball detection
│   ├── renderer.js         # Canvas 2D rendering + AR overlays
│   └── app.js              # Main application controller
└── .github/workflows/
    └── deploy.yml          # GitHub Pages deployment workflow
```

## Physics Model
Based on Dr. Dave Alciatore's billiards physics research and Mathavan et al. (2010) constants:
- Sliding friction μ = 0.20, Rolling friction μ = 0.01
- Ball-ball COR = 0.93, Ball-cushion COR = 0.75
- 9-foot table (2540 × 1270 mm playing surface)
- Fixed timestep at 3 ms per step

## Camera Detection
The camera AR mode uses pure Canvas 2D pixel analysis — no ML library needed:
1. HSV colour segmentation to isolate the green/blue felt
2. Bounding-box table detection
3. Connected-component blob analysis for ball detection
4. HSV colour classification for ball identity

> For production-quality detection, this can be swapped for a YOLOv8-nano model exported to ONNX and run via ONNX Runtime Web — see the planning document `compass_artifact_*.md` for full training details.
