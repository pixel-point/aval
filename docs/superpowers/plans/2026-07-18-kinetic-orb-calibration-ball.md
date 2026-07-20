# Kinetic Orb Calibration Ball Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the fast, phase-inconsistent kinetic orb render with a slow calibration ball whose rendered geometry, illumination, loops, and interactive cuts are visibly continuous.

**Architecture:** Keep the existing five-unit AVAL graph and 96-frame H.264 source, but make Blender consume one pure timeline module that owns absolute rotation, state illumination, portal phases, and analytic seam validation. The visible ball uses only one rotating root and an exactly 15-degree-symmetric set of meridian seams, so each declared portal has a provable matching target phase. Generated frames, the MP4, the compiled AVAL asset, and browser behavior are then verified separately.

**Tech Stack:** Python 3, Blender Python API, Blender EEVEE, FFmpeg/FFprobe, H.264, TypeScript, Playwright, Vite, AVAL compiler.

---

### Task 1: Lock the authored timeline with a failing pure-Python test

**Files:**
- Create: `examples/kinetic-orb/blender/test_timeline.py`
- Create: `examples/kinetic-orb/blender/timeline.py`

**Step 1: Write the failing test**

Add `unittest` cases for:

- 5 degrees of forward motion between every adjacent global source frame;
- exact idle/hover illumination at all unit endpoints;
- rotational equivalence modulo 15 degrees at intro, loop, completion, interrupted-entry, and exit seams;
- portal frames `(2, 5, 8, 11, 14, 17, 20, 23)` and a maximum two-frame wait;
- every idle portal's next pose matching hover-in frame 0 and every hover portal's next pose matching hover-out frame 0.

**Step 2: Run the test to verify it fails**

Run: `python3 examples/kinetic-orb/blender/test_timeline.py`

Expected: failure because `timeline.py` does not yet exist.

**Step 3: Implement the minimum timeline module**

Define the frame ranges, 5-degree absolute angle formula, 15-degree symmetry, constant idle/hover levels, endpoint-inclusive smoothstep transitions, portal frames, and a `validate_timeline()` helper. Keep the module free of `bpy` so it is independently testable.

**Step 4: Run the test to verify it passes**

Run: `python3 examples/kinetic-orb/blender/test_timeline.py`

Expected: all timeline tests pass.

### Task 2: Replace the Blender scene with the calibration ball

**Files:**
- Modify: `examples/kinetic-orb/blender/generate_scene.py`

**Step 1: Remove continuity-breaking objects and functions**

Delete the marker root, marker spheres, latitude cage, nested rotation, breathing scale, pulse functions, and sequential rib charge behavior.

**Step 2: Build the simplified visible object**

Create one matte graphite sphere and twelve identical pale-cyan great-circle seams at 15-degree intervals over 180 degrees. Parent every visible moving part to the same tilted root. Retain a static camera, subdued lighting, dark background, and soft contact floor.

**Step 3: Bake every frame from `timeline.py`**

Use a static X/Y tilt parent and one animated Z-spin child. Bake `pose_for_frame(frame)` into linear rotation and material keyframes from frame -1 through 96 so the saved `.blend` is playable and motion-blur sampling has forward runway on both ends. Set motion-blur shutter to `0.20` and call `validate_timeline()` before saving or rendering.

**Step 4: Run source checks**

Run: `python3 examples/kinetic-orb/blender/test_timeline.py`

Run: `python3 -m py_compile examples/kinetic-orb/blender/timeline.py examples/kinetic-orb/blender/test_timeline.py`

Expected: tests and syntax checks pass.

### Task 3: Update the graph contract and regression assertions

**Files:**
- Modify: `examples/kinetic-orb/motion.json`
- Modify: `tests/kinetic-orb/asset-contract.spec.ts`

**Step 1: Update the assertion first**

Expect both loop port arrays to equal `[2, 5, 8, 11, 14, 17, 20, 23]` and both event portal edges to use `maxWaitFrames: 2`.

**Step 2: Run the focused test to observe the old graph fail**

Run: `npm run test:kinetic-orb:prebuilt -- --grep "phase-locked H.264 graph"`

Expected: portal and wait assertions fail against the old manifest.

**Step 3: Update the authored graph**

Replace the idle and hover portal arrays and set the two event portal wait bounds to two frames. Preserve all ranges, states, completion edges, and bindings.

### Task 4: Update the render and visual-review workflow

**Files:**
- Modify: `examples/kinetic-orb/blender/render.sh`
- Modify: `examples/kinetic-orb/README.md`

**Step 1: Make analytic validation a render prerequisite**

Run the pure timeline test before Blender, launch Blender with factory startup, then render frames 0–95 and encode the existing 512×512, 24 fps, yuv420p H.264 source at CRF 16.

**Step 2: Expand the contact sheet**

Include unit boundaries, all declared idle/hover portal source frames, and their transition targets in the generated review sheet. Document which global frames correspond to each local portal.

**Step 3: Correct the continuity documentation**

Describe the slow 5-degree motion, exact 15-degree symmetry, three-frame portal cadence, two-frame worst-case wait (about 83 ms), constant loop illumination, and absolute source-frame phase.

### Task 5: Render smoke frames and tune legibility

**Files:**
- Modify if required: `examples/kinetic-orb/blender/generate_scene.py`
- Generate: `examples/kinetic-orb/kinetic-orb.blend`
- Generate: `examples/kinetic-orb/source/smoke-*.png`

**Step 1: Render representative frames**

Run Blender smoke renders for frames `0`, `23`, `24`, `36`, `48`, `59`, `60`, `72`, `84`, and `95`.

Expected: intro is visibly dark-to-lit; idle seams remain trackable; hover illumination is unmistakable; geometry size and phase do not jump.

**Step 2: Inspect the rendered images at full size**

Compare sequential boundaries `23→24`, `47→48`, `59→60`, `83→84`, and the equivalent target phases `48≈24` and `84≈60`. Adjust only material, light, line thickness, camera, or shutter values; do not weaken the phase contract.

### Task 6: Render the complete source and verify every cut

**Files:**
- Generate: `examples/kinetic-orb/source/frames/frame-0000.png` through `frame-0095.png`
- Generate: `examples/kinetic-orb/source/kinetic-orb.mp4`
- Generate: `examples/kinetic-orb/source/contact-sheet.jpg`
- Generate: `examples/kinetic-orb/kinetic-orb.blend`

**Step 1: Render and encode**

Run: `npm run render:kinetic-orb`

**Step 2: Verify media metadata**

Run: `ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height,pix_fmt,avg_frame_rate,nb_frames -of json examples/kinetic-orb/source/kinetic-orb.mp4`

Expected: H.264, 512×512, yuv420p, 24/1, and 96 frames.

**Step 3: Verify rendered phase duplicates and ordinary motion**

Compare the image pixels for idle-equivalent frames `24` and `48`, hover-equivalent frames `60` and `84`, every idle portal successor against frame `48`, and every hover portal successor against frame `84`. Confirm the equivalence error is negligible while adjacent non-equivalent frames visibly differ.

**Step 4: Review normal-speed playback and the contact sheet**

Require slow, constant forward rotation with no pause, reverse step, material flash, or geometry snap at any listed cut.

### Task 7: Compile the H.264 AVAL asset and update page messaging

**Files:**
- Modify: `examples/kinetic-orb/index.html`
- Generate: `examples/kinetic-orb/public/kinetic-orb/h264.avl`
- Generate: `examples/kinetic-orb/public/kinetic-orb/build.json`

**Step 1: Update truthful latency copy**

Replace "One frame to react" and "≤ 42 ms" with two-frame/83 ms wording while preserving the existing layout and interaction instructions.

**Step 2: Compile**

Run: `npm run compile:kinetic-orb`

Expected: one CRF 16 H.264 AVAL asset and a regenerated build report.

**Step 3: Update integrity**

Copy `build.json.assets[0].integrity` into the page's `<source>` element.

### Task 8: Run artifact, build, and browser verification

**Files:**
- Modify only if a regression is found: `examples/kinetic-orb/*`, `tests/kinetic-orb/*`

**Step 1: Run focused timeline and artifact checks**

Run: `python3 examples/kinetic-orb/blender/test_timeline.py`

Run: `npm run test:kinetic-orb:prebuilt -- --grep "phase-locked H.264 graph"`

**Step 2: Build the example**

Run: `npm run build -w @pixel-point/aval-kinetic-orb-example`

**Step 3: Run the complete kinetic-orb suite**

Run: `npm run test:kinetic-orb`

Expected: pointer, keyboard, 40-cycle rapid-churn, reuse, asset topology, integrity, and health assertions all pass with no runtime events or fallback.

**Step 4: Perform a final interactive visual pass**

At normal speed, observe the intro, two idle loops, hover-in, two hover loops, hover-out, rapid enter/leave interruption, and return to idle. Reject the result if any video seam is perceptible even when runtime state remains healthy.

### Task 9: Final audit and commit

**Files:**
- Review: all files changed by Tasks 1–8

**Step 1: Audit generated and authored changes**

Run: `git diff --check`

Run: `git status --short`

Confirm that only the calibration-ball source, generated artifacts, graph, demo copy, documentation, and focused assertions changed.

**Step 2: Commit the implementation**

Run: `git add examples/kinetic-orb tests/kinetic-orb docs/superpowers/plans/2026-07-18-kinetic-orb-calibration-ball.md`

Run: `git commit -m "feat: rebuild kinetic orb as continuity proof"`
