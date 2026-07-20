# Windows WebGL-null Canvas2D renderer branch

Status: selected and frozen for implementation

Source revision: `581c3bef20f3b58c1c72770d2e377226f710899a`

Observed run: `20260720T042848Z`

## Objective

Recover interactive AVAL playback when a current browser can decode an AVAL
rendition but cannot create any WebGL context. The recovery is a bounded
Canvas2D presentation backend inside the same source candidate. It is not
static fallback content and it must never advance or reorder the codec ladder:

`AV1 -> VP9 -> H265/HEVC -> H264`

H264 remains the last codec candidate. A renderer failure is not permission to
try another codec.

## Captured discriminator

BrowserStack Live, Windows 11, Chrome `150.0.0.0`, user agent:

```text
Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36
(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36
```

The exact `packed-alpha-48x104` production renderer isolator completed with all
three modes failing in `context-create`:

```json
{
  "production": { "status": "failure", "phase": "context-create" },
  "without-desynchronized": {
    "status": "failure",
    "phase": "context-create"
  },
  "browser-defaults": { "status": "failure", "phase": "context-create" }
}
```

A separate capability canary on the same BrowserStack machine recorded:

```json
{
  "webgl2Production": {
    "available": false,
    "error": null,
    "statusMessage": "Could not create a WebGL context; ANGLE Microsoft Basic Render Driver Direct3D9Ex: BindToCurrentSequence failed"
  },
  "webgl2Defaults": {
    "available": false,
    "error": null,
    "statusMessage": "Could not create a WebGL context; ANGLE Microsoft Basic Render Driver Direct3D9Ex: BindToCurrentSequence failed"
  },
  "webgl1Defaults": {
    "available": false,
    "error": null,
    "statusMessage": "Could not create a WebGL context; ANGLE Microsoft Basic Render Driver Direct3D9Ex: BindToCurrentSequence failed"
  },
  "canvas2d": { "available": true, "error": null },
  "canvas2dPixels": [18, 52, 86, 128],
  "sameCanvasFallback": {
    "webgl2Available": false,
    "canvas2dAfterWebgl2Null": true,
    "pixels": [92, 120, 151, 64]
  }
}
```

This selects the Task 10 Canvas2D branch. It is a provider/driver capability
absence, not a Chrome-major, codec, decoder, or WebGL-call regression. The same
isolator passes locally in Chrome 149 through ANGLE SwiftShader.

Manual evidence is retained at:

- `artifacts/browser-compatibility/manual-live/581c3be/20260720T042848Z/windows-11-chrome-150/playground/01-renderer-context-unavailable.png`
- `artifacts/browser-compatibility/manual-live/581c3be/20260720T042848Z/windows-11-chrome-150/renderer-isolator/01-all-modes-context-create-failure.png`
- `artifacts/browser-compatibility/manual-live/581c3be/20260720T042848Z/windows-11-chrome-150/capability-probe/01-webgl-unavailable-canvas2d-working.png`
- `artifacts/browser-compatibility/manual-live/581c3be/20260720T042848Z/windows-11-chrome-150/capability-probe/02-same-canvas-fallback-working.png`

These are operator evidence, not machine-verifiable BrowserStack Automate
artifacts.

## Frozen selection rule

1. Construct the existing WebGL2 backend first.
2. If and only if `getContext("webgl2", productionAttributes)` returns exactly
   `null` without binding a context, throw an internal specialized
   `WebGlUnavailableError` and construct Canvas2D on that same canvas.
3. Do not select Canvas2D for a thrown `getContext`, an already-lost context,
   capability/program/texture failure, upload/draw failure, or runtime context
   loss.
4. If Canvas2D construction also fails, publish one canonical terminal
   `renderer-failure`.
5. Never retry a source or advance the codec ladder because of either backend.

The provisional WebGL-null discriminator is not retained as a terminal failure
when Canvas2D succeeds.

## Implementation shape

Create:

- `packages/element/src/renderer-geometry.ts`
  - shared immutable layout/frame validation;
  - checked byte arithmetic;
  - one viewport calculation for fit, pixel aspect, DPR, centering, and cover
    offsets.
- `packages/element/src/canvas2d-renderer.ts`
  - isolated backend implementing the existing renderer operations;
  - bounded RGBA materialization, packed-alpha composition, resident storage,
    resize redraw, context events, diagnostics, and disposal.
- `packages/element/src/renderer-selection.ts`
  - sole WebGL2-to-Canvas2D selection boundary.
- `packages/element/test/canvas2d-renderer.test.ts`
- `packages/element/test/renderer-selection.test.ts`

Modify:

- `packages/element/src/renderer.ts`
- `packages/element/src/renderer-diagnostics.ts`
- `packages/element/src/player.ts`
- `packages/element/src/player-contract.ts`
- `packages/element/src/public-types.ts`
- `packages/element/src/aval-element.ts`
- `examples/support/aval-browser-diagnostics.js`
- `scripts/browser-compatibility/renderer-isolator.js`
- focused renderer/player/diagnostic/public API and cleanup tests.

The exported `Renderer` becomes a small structural delegator. The existing
WebGL implementation remains preferred and strict. Both backends expose the
same `resize`, `draw`, `store`, `drawStored`, `settled`, `admit`, `snapshot`,
and `dispose` contract.

## Canvas2D pixel contract

- Use the existing timed and exact `VideoFrame.copyTo(..., {format:"RGBA"})`
  contract first.
- Only a normal unsupported-copy exception may use a detached Canvas2D
  readback path. Timeout and invalid plane-layout evidence remain terminal.
- Materialize packed frames into independent color and alpha surfaces. Never
  scale directly from the packed sprite sheet because filter sampling may
  bleed authored gutter/padding pixels.
- Force decoded color alpha to `255`.
- Copy the alpha-pane red channel into the mask alpha channel.
- Keep color straight/unpremultiplied. Canvas2D performs backing
  premultiplication; JavaScript premultiplication would apply alpha twice.
- Clear output, draw scaled color with `source-over`, then apply the scaled mask
  with `destination-in`.
- Share the WebGL viewport result for `contain`, `cover`, `fill`, `none`, pixel
  aspect, DPR, integer rounding, and resize redraw.
- Enable image smoothing with low quality to approximate WebGL linear
  filtering. Alpha/composite parity uses existing tolerances rather than
  claiming cross-backend filter-bit identity.

## Resource and lifecycle invariants

Let:

- `P = storageWidth * storageHeight * 4`
- `F = colorWidth * colorHeight * 4 * (alpha ? 2 : 1)`

Canvas2D owns exactly three bounded streaming frame buffers. Resident frames
are keyed CPU buffers; the last presented identity is retained for resize
redraw.

- `stagingBytes = P + 3F`
- `residentBytes = residentCount * F`
- `textureBytes = 0`
- backing accounting includes the output, color scratch, optional alpha
  scratch, and readback scratch using the existing conservative `5/4`
  allocation multiplier.
- admission reserves one additional `P` during detached readback peak.
- the existing texture, backing, and runtime caps remain hard caps.
- invalid/unsafe arithmetic remains terminal and is never converted into
  fallback selection.

Listen for Canvas2D `contextlost` and `contextrestored` on the output canvas.
Loss uses the existing nonterminal loss notification and restore timeout. On
restore, reacquire/reset state and redraw the last CPU frame. Scratch-context
failure or an unsupported restore is terminal. Resizing resets context state,
so smoothing and compositing state are reapplied after every backing change.

`dispose()` removes listeners, retires pending work, clears all slots/maps, and
sets every owned canvas backing to zero. Cleanup diagnostics must return all
bytes/resources/listeners to zero.

## Diagnostics contract

- Add `backend: "webgl2" | "canvas2d"` to renderer failure diagnostics.
- Add `rendererBackend: "webgl2" | "canvas2d" | null` to player and public
  runtime diagnostics.
- Show the active backend beside the selected codec in the query-gated overlay.
- Canvas failures reuse generic phases (`context-create`, `rgba-copy`, `draw`,
  `resize`, `context-event`); GL-only fields are `null`.
- WebGL diagnostics and strict failure phases/enums remain unchanged.

## First red assertions

Before implementation, add tests proving:

1. WebGL2 returning exact `null` currently terminalizes instead of selecting a
   working Canvas2D context on the same canvas.
2. A packed-alpha frame with alpha samples `0`, `128`, and `255` cannot be
   presented interactively without WebGL.
3. A WebGL exception/program/device/upload/draw failure must not select
   Canvas2D.
4. When both backends are unavailable, one terminal renderer error is
   published and only the original codec candidate is opened.

## Required tests

Canvas2D unit/parity coverage:

- opaque and odd-padded packed-alpha samples;
- alpha `0/128/255`, forced-opaque color, and no gutter bleed;
- all fit modes, pixel aspect, DPR, cover offsets, and resize redraw;
- three streaming slots, resident identity, duplicate/missing resident errors;
- exact admission and peak byte budgets;
- copy success, allowed readback fallback, invalid layout, timeout, and abort;
- context loss/restoration and terminal scratch failure;
- disposal during pending work and complete zero ownership.

Selection/player coverage:

- exact WebGL null selects Canvas2D on the same canvas;
- ordinary WebGL success remains `webgl2`;
- thrown/lost/program/device/runtime WebGL failures never fall through;
- Canvas construction failure produces one terminal public error;
- renderer fallback does not move AV1 -> VP9 -> H265 -> H264;
- public diagnostics and overlay report the active backend.

Real-browser coverage intercepts only `getContext("webgl2")` to return `null`
and requires `interactiveReady`, `rendererBackend === "canvas2d"`, the highest
playable modern codec, visible packed alpha, authored interaction, resize, and
a clean soak.

## Acceptance commands

```bash
npx vitest run --config vitest.m9.config.ts \
  packages/element/test/canvas2d-renderer.test.ts \
  packages/element/test/renderer-selection.test.ts \
  packages/element/test/renderer.test.ts \
  packages/element/test/player-selection.test.ts \
  packages/element/test/player-startup-source-fallback.test.ts \
  packages/element/test/player-prefetch.test.ts
npm run typecheck
npm run build
npm run test:unit
npm run test:playground
npm run test:grass-rabbit
npm run test:grass-rabbit-codecs
npm run test:kinetic-orb
```

Then rebuild and tunnel an exact clean commit. Rerun Windows 11 Chrome
150/149/148/127 across `/playground/`, `/rabbit/`, `/codecs/`, and `/orb/` in
full-ladder and forced-H264 modes. Require authored pointer/focus states and a
minimum 60-second soak. Preserve the failing baseline and write new
platform-named screenshots. Also verify normal Chrome, Firefox, Safari, iOS,
Android, Samsung, and Brave continue preferring WebGL2 where it exists.

## Rejected branches

- WebGL1: the captured provider also returns `null`.
- Canvas2D everywhere: unnecessary CPU and filtering cost on WebGL-capable
  browsers.
- Consumer/static fallback: AVAL owns only an interactive renderer or a typed
  terminal error; applications own images or noninteractive video.
- Codec retry for renderer failure: violates candidate ownership and could
  incorrectly force iPhone from HEVC to H264.
