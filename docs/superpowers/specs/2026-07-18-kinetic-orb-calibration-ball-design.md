# Kinetic Orb Calibration Ball Redesign

## Purpose

Replace the current kinetic orb source with a deliberately simple calibration scene that makes rotational continuity easy to judge by eye. The existing source moves too quickly and combines several independent motions, so its repeated cage can appear continuous while its inner markers jump at source, loop, and interactive transition seams.

This redesign changes only the Blender-authored example, its H.264 source, its compiled AVAL asset, documentation, and example assertions. It does not change the runtime or compiler.

## Confirmed problem

The current scene advances its main root by 15 degrees per frame, or one full revolution per second at 24 fps. Its inner marker root advances by `1.7 * angle` beneath the already-rotating ball root, so the markers move by an effective 40.5 degrees per frame. Motion blur uses a 0.72-frame shutter.

The graph declares a safe portal after every odd loop frame because the six repeated great circles make the cage visually equivalent every 30 degrees. That equivalence does not hold for the marker constellation: its alternating height pattern repeats only after 180 degrees, and its independent rotation phase resets to zero at the start of every unit. The transition contract is therefore true for the cage but false for the most visible moving detail. Large blur makes the mismatch less readable without making it continuous.

The material animation also violates the portal contract. Idle and hover loops pulse independently of portal phase, while hover-in and hover-out always begin at one fixed brightness. A valid rotational cut can therefore still pop in luminance. The current contact sheet checks only global source boundaries and misses the full set of portal-to-target cuts.

## Considered approaches

### 1. Calibration ball with repeated meridian seams — selected

Use one matte ball, twelve identical high-contrast meridian seams, and no independently moving objects. The ball rotates by 5 degrees per frame. Twelve great circles spaced across 180 degrees create exact 15-degree visual symmetry, allowing a safe transition every three frames.

This preserves a low worst-case transition wait while making frame-to-frame motion slow and legible. The repeated lines are sufficient to track direction and speed without introducing a unique phase marker that would invalidate dense portals.

### 2. Ball with one unique stripe — rejected

A unique stripe would make phase errors maximally obvious, but it would also make only one phase per revolution safe. Keeping low interaction latency would require multiple phase-specific transition units and substantially more graph complexity. That would obscure the simple continuity lesson.

### 3. Stationary ball with an orbiting halo — rejected

An orbiting repeated halo could preserve dense safe portals, but it would no longer strongly demonstrate that a rotating video subject can pass through interactive states continuously.

## Approved visual design

The scene is a restrained calibration object rather than a glossy science-fiction orb:

- one centered graphite sphere;
- twelve identical pale-cyan meridian seams, thick enough to follow at normal playback size;
- no latitude cage, floating markers, secondary rotation, breathing scale, or per-rib charge sequence;
- a fixed tilted ball axis and static camera;
- a dark neutral background and soft floor contact shadow;
- idle illumination that clearly exposes the lines;
- hover illumination that brightens the central sphere and seams uniformly;
- a motion-blur shutter of 0.20 frames, low enough to retain readable line positions.

The hover state is communicated only through light. Geometry, camera, scale, and angular velocity remain unchanged through every state.

## Timeline and phase contract

The source remains 512×512, 24 fps, 96 frames, and H.264. Existing unit ranges remain unchanged:

| Unit | Range | Frames | Light behavior |
| --- | ---: | ---: | --- |
| `intro` | `[0, 24)` | 24 | dark to exact idle level |
| `idle-loop` | `[24, 48)` | 24 | constant idle level |
| `hover-in` | `[48, 60)` | 12 | exact idle to exact hover level |
| `hover-loop` | `[60, 84)` | 24 | constant hover level |
| `hover-out` | `[84, 96)` | 12 | exact hover to exact idle level |

Every source frame advances the ball by exactly 5 degrees using the single absolute formula `angle = (source_frame - 24) * 5°`. The Blender transform never resets at a global unit boundary, so motion-blur sampling also sees constant forward velocity. Intro frame 23 is at `-5°`, idle starts at `0°`, hover-in starts at `120°`, hover-loop starts at `180°`, and hover-out starts at `300°`.

The twelve great circles make orientations separated by 15 degrees visually identical. A source portal is safe when the next ordinary pose is a multiple of 15 degrees. Both loop ports therefore expose:

`[2, 5, 8, 11, 14, 17, 20, 23]`

Both event-triggered portal edges use `maxWaitFrames: 2`, producing an authored worst-case wait of about 83 ms at 24 fps.

The rotational seams are:

- intro frame 23 (`-5°`) → idle frame 0 (`0°`);
- idle frame 23 (`115°`) → idle frame 0, visually equivalent to the expected `120°`;
- any idle portal → hover-in frame 0, visually equivalent to the next multiple of `15°`;
- hover-in frame 11 (`175°`) → hover-loop frame 0 (`180°`);
- hover-loop frame 23 (`295°`) → hover-loop frame 0 (`180°`), visually equivalent to the expected `300°`;
- any hover portal → hover-out frame 0;
- hover-in frame 11 (`175°`) → hover-out frame 0 (`300°`) for interrupted entry, visually equivalent to the expected `180°`;
- hover-out frame 11 (`355°`) → idle frame 0 (`0°`), visually equivalent to the expected `360°`.

There is no animation reset hidden by unrelated geometry. The full visible object obeys the same 15-degree symmetry contract.

## Illumination contract

Idle and hover loops use constant material values; neither loop pulses. Intro uses `smoothstep(frame / 23)` so frame 23 exactly equals idle. Hover-in uses `smoothstep(local_frame / 11)` so its frame 0 exactly equals idle and frame 11 exactly equals hover. Hover-out uses the same progress in reverse, making its first frame exactly hover and its final frame exactly idle.

These sampled endpoints intentionally duplicate only material values. Rotation advances on every frame, so the animation never visually pauses at a state boundary.

## Blender and generated artifacts

`examples/kinetic-orb/blender/generate_scene.py` remains the deterministic source of the `.blend` and all rendered frames. Its setup code will be simplified to remove the marker root, marker spheres, latitude loops, secondary angular function, and sequential charge logic.

The fixed X/Y tilt lives on a static parent while the authored Z spin lives on one child, so Euler composition cannot rotate the ball around the wrong effective axis. Rotation and illumination are baked as linear keyframes from frame -1 through frame 96; those runway keys preserve forward motion-blur sampling and make the saved `.blend` independently playable. Rendering starts from Blender's factory startup, and both the source MP4 and compiled H.264 rendition use CRF 16 to minimize compression changes between independently encoded units.

`examples/kinetic-orb/blender/render.sh` continues to render frames 0–95, encode `source/kinetic-orb.mp4`, and produce `source/contact-sheet.jpg`. The contact sheet will include every global unit seam, every declared portal source frame, and the transition target frames so visual review covers source playback, runtime looping, and event-driven cuts.

After rendering, `motion.json` is updated with the new portal frames and wait bound, then the H.264 `.avl` is recompiled. The `<source>` integrity value in `index.html` must be replaced with the value emitted by the compiler.

## Verification

Verification has four layers:

1. **Analytic phase checks:** assert one absolute 5-degree velocity and validate every listed seam modulo 15 degrees.
2. **Rendered frame review:** inspect contact sheets containing every valid portal cut and short playback at normal speed, checking that line positions advance in one direction without a snap at intro, loops, hover entry, hover sustain, exit, or interrupted entry.
3. **Artifact checks:** assert 96 512×512 PNGs, a 96-frame 24 fps H.264/yuv420p MP4, the new portal array, `maxWaitFrames: 2`, a valid `.avl`, and matching HTML integrity.
4. **Browser checks:** run the existing pointer, keyboard, and 40-cycle rapid-churn tests; require interactive readiness, no runtime events, no underflow or fallback, continued frame changes, and reuse after stress.

The seam review is not satisfied merely because the graph validates or the browser remains error-free. The rendered source itself must visibly advance with the same direction and approximate displacement at every boundary.

## Scope

This change keeps the existing page layout, H.264-only delivery, unit ranges, state graph, Blender/FFmpeg toolchain, and runtime behavior. It does not add codecs, new interactions, audio, transparency, phase-specific graph branches, or runtime changes.
