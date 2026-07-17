# Kinetic Orb Interactive Video Demo Design

## Purpose

Create a Blender-authored interactive-video example that makes AVAL's stateful playback immediately legible. Unlike the grass-rabbit source, motion never settles: the focal object rotates in every state, transition waits are nearly imperceptible, and every seam is authored for continuous forward motion.

The first version publishes only H.264. It is a visual and interaction proof, not a multi-codec production artifact.

## Approved visual direction

The scene is a square, near-black product shot centered on a graphite kinetic orb. The orb has twelve evenly spaced cyan emissive ribs, a smaller suspended graphite inner shell, and repeated inner energy markers. A soft floor reflection, blue rim lighting, emissive materials, and motion blur give the render depth without competing with the interaction. Blender 5.1's legacy compositor output node is not used, keeping the generated scene portable across its current background renderer.

The animation language is:

- `intro`: the orb begins almost dark, the ribs charge in sequence, and rotation accelerates into the established constant speed.
- `idle-loop`: the orb rotates continuously at one revolution per second. Ribs remain visible, while the core stays dim.
- `hover-in`: rotation continues unchanged while the core brightens, the shell glow spreads inward, and the energy marker appears.
- `hover-loop`: rotation continues unchanged. The bright core breathes gently and the energy marker orbits, making the sustained hover state unmistakable.
- `hover-out`: rotation continues forward at the same speed while the marker fades and the core discharges back to the idle level.

The intro may accelerate into the idle speed, but frames after the intro use a single constant angular velocity.

## Timeline and seam contract

The source is a 512×512, 24 fps, opaque H.264 MP4 assembled from Blender PNG renders.

| Unit | Half-open range | Frames | Behavior |
| --- | ---: | ---: | --- |
| `intro` | `[0, 24)` | 24 | one-shot charge-up |
| `idle-loop` | `[24, 48)` | 24 | one revolution, looping |
| `hover-in` | `[48, 60)` | 12 | finite power-up |
| `hover-loop` | `[60, 84)` | 24 | one revolution, looping |
| `hover-out` | `[84, 96)` | 12 | finite discharge |

Frames are rendered from analytic functions instead of independent hand-keyed poses. For all non-intro frames, orb angle is derived from the local frame phase at 15 degrees per frame. The twelve repeated ribs make every 30-degree orientation visually equivalent.

Idle and hover loop ports expose portal frames `[1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23]`. A portal is therefore at most one frame away. The frame following any portal is a multiple of 30 degrees and visually matches the zero-phase first frame of the relevant transition. `maxWaitFrames` is `1`, giving a worst-case authored input delay of 42 ms at 24 fps.

Transition endpoints follow the same phase rule:

- intro frame 23 flows into idle frame 0;
- idle frame 23 flows into idle frame 0;
- an idle portal flows into hover-in frame 0;
- hover-in frame 11 flows into hover-loop frame 0;
- hover-loop frame 23 flows into hover-loop frame 0;
- a hover-loop portal flows into hover-out frame 0;
- hover-out frame 11 flows into idle frame 0.

Motion blur uses the same angular velocity on both sides of each seam. Hover-out is separately rendered and never implemented by reversing hover-in, because reversing the clip would reverse the orb's rotation.

## Blender generation

`examples/kinetic-orb/blender/generate_scene.py` owns the complete procedural scene. It clears the file, creates materials and geometry, configures Eevee, camera, lighting, compositor effects, and animation drivers/keyframes, then saves `kinetic-orb.blend`. A second command renders frames 0–95 to `source/frames/` and FFmpeg creates `source/kinetic-orb.mp4` using constant-frame-rate H.264/yuv420p.

The script must be deterministic and rerunnable. Scene generation and rendering are separate CLI operations so visual iteration does not require rebuilding the scene by hand.

## AVAL graph

The graph mirrors the grass-rabbit finite-state structure:

- initial `idle` state with `intro` as its one-shot initial unit and `idle-loop` as its body;
- transient `entering` state backed by `hover-in`;
- `hover` state backed by `hover-loop`;
- transient `exiting` state backed by `hover-out`.

Pointer/focus engagement emits `hover.enter` and `hover.leave`. Leaving during `hover-in` records the exit intent, allows the short 12-frame power-up to complete, and then immediately plays `hover-out` without presenting a hover-loop frame. This bounds the longest interrupted-enter response while preserving authored continuity.

Only one H.264 rendition is compiled at 512×512 using CRF 20 and the medium preset.

## Web demo

Add `examples/kinetic-orb` as a workspace example following the grass-rabbit project structure. The page is a focused dark showcase rather than a copy of the full marketing page:

- a compact header identifying the experiment;
- the square interactive player centered in the viewport;
- a live state badge (`intro`, `idle`, `entering`, `hover`, `exiting`);
- a short hint to hover or focus;
- a compact timeline legend explaining the five authored units and the one-frame portal wait.

The player is keyboard focusable. Pointer hover and focus use the element's existing engagement bindings. Reduced-motion mode skips decorative CSS reveals but leaves the player fallback behavior to the runtime.

## Verification

Verification covers three layers:

1. Blender/source checks: exactly 96 numbered PNG frames, 512×512 dimensions, 24 fps MP4, H.264 codec, yuv420p pixel format, and no audio.
2. Seam checks: compare each authored seam with image metrics and contact sheets. Exact pixel identity is not expected because lighting and motion blur evolve, but no large discontinuity may appear in orb centroid, silhouette, or rotational rib phase.
3. Browser checks: the compiled H.264 `.avl` reaches interactive readiness, intro completes once, hover reaches `hover`, leave reaches `idle`, state labels update, and measured idle-to-entering transition wait is no more than one presented source frame.

The generated `.blend`, source MP4, compiled H.264 bundle, and a small contact sheet are retained with the example so the demo can be reviewed without rerendering.

## Scope boundaries

This iteration does not add AV1, VP9, H.265, transparency, audio, click states, drag interaction, or runtime/compiler changes. It uses the current AVAL public element and compiler contracts unchanged.
