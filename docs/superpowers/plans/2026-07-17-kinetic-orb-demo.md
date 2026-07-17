# Kinetic Orb Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Blender-authored, continuously rotating kinetic-orb interactive-video demo with intro, idle, hover-in, hover-loop, and hover-out states, compiled as H.264 AVAL.

**Architecture:** A deterministic Blender Python script creates and animates a 512×512 Eevee scene over one 96-frame source timeline. The existing AVAL compiler slices that H.264 source into five units, while a small Vite example presents the single-codec bundle and exposes state changes in the UI.

**Tech Stack:** Blender 5.1 Python API, Eevee, FFmpeg/libx264, AVAL compiler and `<aval-player>`, Vite, vanilla JavaScript/CSS, Playwright.

---

## File map

- `examples/kinetic-orb/blender/generate_scene.py`: deterministic Blender scene creation, animation, frame rendering, and blend-file save.
- `examples/kinetic-orb/blender/render.sh`: documented local render and FFmpeg assembly commands.
- `examples/kinetic-orb/source/frames/`: 96 generated PNG source frames.
- `examples/kinetic-orb/source/kinetic-orb.mp4`: constant-frame-rate H.264 source.
- `examples/kinetic-orb/source/contact-sheet.jpg`: generated seam-review artifact.
- `examples/kinetic-orb/kinetic-orb.blend`: editable generated Blender scene.
- `examples/kinetic-orb/motion.json`: five-unit AVAL graph and single H.264 rendition.
- `examples/kinetic-orb/index.html`: accessible showcase markup.
- `examples/kinetic-orb/main.js`: player readiness and visible-state presentation.
- `examples/kinetic-orb/style.css`: responsive dark product-shot presentation.
- `examples/kinetic-orb/package.json`: Vite and compiler scripts.
- `examples/kinetic-orb/vite.config.js`: Vite configuration.
- `examples/kinetic-orb/README.md`: regeneration, frame ranges, and seam contract.
- `examples/kinetic-orb/public/kinetic-orb/`: compiled H.264 `.avl` and `build.json`.
- `tests/kinetic-orb/kinetic-orb.spec.ts`: artifact and browser interaction checks.
- `playwright.kinetic-orb.config.ts`: isolated example test server.
- `package.json`: workspace and root scripts.
- `package-lock.json`: workspace lockfile update.

### Task 1: Scaffold the example and authoring contract

- [ ] **Step 1: Add the workspace package**

Create `examples/kinetic-orb/package.json` with scripts `dev`, `build`, `compile`, and `render`, dependency `@pixel-point/aval-element`, and the same Vite/Tailwind-free local workspace dependency pattern as the grass-rabbit example.

- [ ] **Step 2: Add root integration**

Add `examples/kinetic-orb` to `workspaces` and root scripts `kinetic-orb`, `render:kinetic-orb`, `compile:kinetic-orb`, and `test:kinetic-orb`.

- [ ] **Step 3: Install the workspace link**

Run: `npm install --package-lock-only`

Expected: exit code 0 and `package-lock.json` includes `examples/kinetic-orb`.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json examples/kinetic-orb/package.json examples/kinetic-orb/vite.config.js
git commit -m "chore: scaffold kinetic orb example"
```

### Task 2: Generate the Blender scene

- [ ] **Step 1: Write the deterministic scene generator**

Create `generate_scene.py` with constants `FPS = 24`, `FRAME_END = 95`, `SIZE = 512`, named collections and materials, a central orb root, graphite shell, repeated emissive ribs, translucent core, inner marker, floor, camera, area lights, Eevee motion blur, and a world background.

Use a frame-change handler that calculates each pose from the current source frame. The handler must derive rotation, core energy, rib energy, and marker energy from explicit unit-local functions, and it must preserve `15° / frame` rotation for frames 24–95.

- [ ] **Step 2: Add scene/render CLI behavior**

Support `--render` after Blender's `--` separator. Without it, save `kinetic-orb.blend`; with it, save the blend file and render frames 0–95 to `source/frames/frame-####.png`.

- [ ] **Step 3: Run a single-frame smoke render**

Run:

```bash
/Applications/Blender.app/Contents/MacOS/Blender --background --python examples/kinetic-orb/blender/generate_scene.py -- --smoke-frame 36
```

Expected: exit code 0, a saved `.blend`, and one 512×512 PNG showing a centered readable orb.

- [ ] **Step 4: Inspect the smoke render**

Open the PNG and adjust camera, exposure, materials, or lighting until the dark shell, cyan ribs, and floor separation are readable.

- [ ] **Step 5: Commit**

```bash
git add examples/kinetic-orb/blender examples/kinetic-orb/kinetic-orb.blend
git commit -m "feat: author kinetic orb Blender scene"
```

### Task 3: Render and encode the source timeline

- [ ] **Step 1: Render all frames**

Run:

```bash
/Applications/Blender.app/Contents/MacOS/Blender --background --python examples/kinetic-orb/blender/generate_scene.py -- --render
```

Expected: 96 PNG files named `frame-0000.png` through `frame-0095.png`.

- [ ] **Step 2: Encode constant-frame-rate H.264**

Run:

```bash
ffmpeg -y -framerate 24 -start_number 0 -i examples/kinetic-orb/source/frames/frame-%04d.png -an -c:v libx264 -preset medium -crf 16 -pix_fmt yuv420p -r 24 -movflags +faststart examples/kinetic-orb/source/kinetic-orb.mp4
```

Expected: a 512×512, 24 fps, 96-frame H.264 MP4 with no audio stream.

- [ ] **Step 3: Generate a seam contact sheet**

Extract frames `23,24,47,48,59,60,83,84,95` and tile them into `source/contact-sheet.jpg`, labeling their frame numbers with FFmpeg's drawtext filter when available.

- [ ] **Step 4: Verify source metadata**

Run:

```bash
ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height,pix_fmt,avg_frame_rate,nb_frames -of json examples/kinetic-orb/source/kinetic-orb.mp4
```

Expected: `h264`, `512`, `512`, `yuv420p`, `24/1`, and `96`.

- [ ] **Step 5: Commit**

```bash
git add examples/kinetic-orb/source examples/kinetic-orb/kinetic-orb.blend
git commit -m "feat: render kinetic orb source animation"
```

### Task 4: Author and compile the AVAL graph

- [ ] **Step 1: Write `motion.json`**

Define the exact ranges `[0,24)`, `[24,48)`, `[48,60)`, `[60,84)`, and `[84,96)`. Configure only H.264 at 512×512, CRF 20, preset `medium`. Add the `idle`, `entering`, `hover`, and `exiting` states and the same finite routing behavior as grass-rabbit.

Both loop ports must use portal frames `[1,3,5,7,9,11,13,15,17,19,21,23]`; the two event-triggered portal edges must use `maxWaitFrames: 1` and `continuity: "exact-authored"`.

- [ ] **Step 2: Compile public packages and the example**

Run: `npm run compile:kinetic-orb`

Expected: `examples/kinetic-orb/public/kinetic-orb/h264.avl` and `build.json`.

- [ ] **Step 3: Validate the artifact**

Run:

```bash
npm run avl -- validate examples/kinetic-orb/public/kinetic-orb/h264.avl
```

Expected: validation succeeds with no graph, codec, timing, or integrity error.

- [ ] **Step 4: Commit**

```bash
git add examples/kinetic-orb/motion.json examples/kinetic-orb/public/kinetic-orb
git commit -m "feat: compile kinetic orb interaction graph"
```

### Task 5: Build the demo page

- [ ] **Step 1: Add accessible markup**

Create one square `<aval-player id="kinetic-orb">`, insert the exact `<source>` element from `build.json.sourceMarkup`, add `tabindex="0"`, and label the player so hover and keyboard-focus behavior are discoverable.

- [ ] **Step 2: Add state presentation**

In `main.js`, import `@pixel-point/aval-element/auto`, reveal the rendered player after readiness, detect the one-shot intro through runtime diagnostics, and update a live badge from `visualstatechange`.

- [ ] **Step 3: Add responsive visual styling**

Build a focused black/blue page that keeps the player square, provides a visible hover/focus affordance, and lays out the unit legend without obscuring the animation. Disable only decorative CSS transitions under reduced motion.

- [ ] **Step 4: Add regeneration documentation**

Document scene generation, rendering, encoding, compilation, frame ranges, portal latency, and local preview commands in `README.md`.

- [ ] **Step 5: Build the example**

Run: `npm run build -w @pixel-point/aval-kinetic-orb-example`

Expected: Vite exits 0 and produces the page plus the H.264 bundle in `dist/`.

- [ ] **Step 6: Commit**

```bash
git add examples/kinetic-orb
git commit -m "feat: add kinetic orb interactive demo"
```

### Task 6: Verify interaction and seams

- [ ] **Step 1: Add artifact assertions**

In `kinetic-orb.spec.ts`, assert source metadata, exact unit ranges, dense portal arrays, one H.264 build asset, and matching source markup/integrity.

- [ ] **Step 2: Add browser interaction assertions**

Start from interactive readiness, wait for intro to resolve to idle, hover the player, assert `hover`, move away, assert `idle`, focus and blur for the keyboard path, and fail on page/player errors.

- [ ] **Step 3: Add the isolated Playwright config**

Serve the example on a dedicated localhost port with a 512×512-capable viewport and one Chromium worker.

- [ ] **Step 4: Run automated verification**

Run: `npm run test:kinetic-orb`

Expected: all artifact and browser tests pass.

- [ ] **Step 5: Perform visual verification**

Inspect the intro, at least two idle loops, hover entry, at least two hover loops, hover exit, and return to idle. Confirm forward rotation never stops, the powered state is unambiguous, no black frame appears, and portal waits are not perceptible.

- [ ] **Step 6: Run repository checks for touched code**

Run:

```bash
npm run typecheck
npm run build -w @pixel-point/aval-kinetic-orb-example
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit**

```bash
git add tests/kinetic-orb playwright.kinetic-orb.config.ts package.json examples/kinetic-orb
git commit -m "test: verify kinetic orb interactive continuity"
```
