# Browser Output Qualification Design

**Date:** 2026-07-20

**Status:** Approved by the user's earlier instruction to continue autonomously
with the recommended compatibility approach; refined after the 2026-07-20
thermo-nuclear maintainability checkpoint.

**Decision:** Treat browser-reported color metadata through one typed semantic
classifier, prove packed-alpha output against a compiler-authored bounded
witness before publishing readiness, and make source fallback consume a typed
candidate-rejection disposition. Keep renderer lifecycle in one controller with
small WebGL2 and Canvas2D backends.

## 1. Objective

AVAL must work on the supported Firefox, Chromium, Android, Windows, and Safari
matrix without weakening the authored codec order or hiding corrupt output
behind a readiness flag. The source order remains:

`AV1 -> VP9 -> HEVC/H.265 -> H.264`

H.264 is selected only after every higher-ranked authored candidate fails
startup qualification. AVAL never owns a static or video fallback. When every
candidate fails, it publishes the existing typed terminal error so the
application can render its own image, noninteractive video, text, or other
fallback.

This design addresses two independently reproduced Android failures:

1. valid decoded output is rejected because Android reports a functionally
   equivalent transfer characteristic; and
2. a ten-bit packed-alpha AV1 candidate reaches `interactiveReady` while the
   decoded pixels render as an opaque black rectangle.

It also closes the maintainability regression created by implementing the
Canvas2D path as a second renderer runtime rather than as a small presentation
backend.

## 2. Captured Evidence

### 2.1 Android color normalization

BrowserStack Live on a real Samsung Galaxy S24 / Android 14 captured the exact
first rejected frame for both AV1 and VP9 Rabbit controls.

The configured and expected tuple is:

```json
["bt709", "bt709", "bt709", false]
```

The browser returns:

```json
["bt709", "smpte170m", "bt709", false]
```

Only the transfer member differs. The WebCodecs specification explicitly
defines the `smpte170m` transfer characteristic as functionally the same as
`bt709`:

<https://w3c.github.io/webcodecs/#video-transfer-characteristics>

The Android Chromium bridge also maps Android's standard SDR transfer value to
SMPTE 170M. This is browser normalization, not a color-gamut, matrix, or range
change:

<https://chromium.googlesource.com/chromium/src/+/main/media/base/android/media_codec_bridge_impl.cc>

### 2.2 Packed-alpha corruption

The End-user Playground's AV1 source is ten-bit packed alpha. On Samsung Galaxy
S24 / Android 14 and Google Pixel 9 / Android 15 it passes configuration,
decode metadata, upload, and the existing native-versus-RGBA renderer probe,
then publishes `interactiveReady` with an opaque black rectangle.

The current renderer probe only proves that two browser conversion paths agree.
Shared corruption therefore passes. It has no authored semantic reference for
what the decoded alpha plane should contain.

### 2.3 Firefox floor

Firefox 152 already passes all four demos. Firefox 128 produces the intended
typed `unsupported-profile` result because Mozilla enabled desktop WebCodecs in
Firefox 130. No Firefox-specific branch is justified. The supported floor is
Firefox 130; Firefox 129 and 128 remain required negative sentinels.

## 3. Non-negotiable Contracts

- Authored source order is the only codec-priority policy.
- No user-agent, OS-name, device-name, or codec-name exception enters color or
  pixel validation.
- H.264 is not preferred merely because it is broadly available.
- Startup candidate fallback is allowed only before publication and only for a
  typed `retry-next-candidate` result.
- A post-publication failure remains terminal; AVAL does not hot-switch active
  playback.
- Network, integrity, malformed-format, resource, cleanup, timeout, and policy
  failures are never relabeled as codec incompatibility.
- AVAL raises a typed error after terminal exhaustion and does not render
  fallback content.
- Diagnostics retain exact expected and observed metadata but do not control
  fallback by reverse-engineering their field shapes.

## 4. Approaches Considered

### 4.1 Add an Android condition and rebuild the AV1 asset

This is the smallest patch: accept `smpte170m` in `matchesColor()` and encode
the Playground AV1 rendition as eight-bit. It is rejected because it couples
semantic policy to one observed platform, leaves the oversized decoder intact,
and still allows a future corrupt decoder result to publish readiness.

### 4.2 Add a generic nonblack or alpha-variance heuristic

This would sample decoded pixels and reject frames that appear uniformly black
or opaque. It is rejected because valid authored frames may deliberately be
uniform, fully opaque, or fully transparent. A heuristic has no way to
distinguish valid content from corruption and would become another ad-hoc
fallback condition duplicated across WebGL2 and Canvas2D.

### 4.3 Typed semantic equivalence plus an authored witness

This is selected. Color metadata is classified by a pure authority with named
equivalences. Packed-alpha qualification uses a small compiler-authored witness
derived from canonical source pixels. One renderer controller performs the
bounded materialization and witness check before delegating storage and drawing
to either backend. Candidate selection consumes a typed rejection disposition.

The selected approach costs one bounded startup RGBA materialization for a
witness-bearing candidate and requires regenerated example assets, but it is
capability-based, deterministic, testable, and independent of browser names.

## 5. Color-space Classification

Create a focused decoder color module that owns all semantic comparison. It
returns a discriminated result instead of a boolean:

```ts
type DecoderColorClassification =
  | { kind: "exact" }
  | {
      kind: "known-normalization";
      normalization:
        | "bt709-transfer-as-smpte170m"
        | "limited-bt709-srgb-transfer";
    }
  | { kind: "incompatible"; field: "range" | "matrix" | "primaries" | "transfer" };
```

For an exact limited-BT.709 expectation, the classifier accepts:

- the exact tuple;
- `smpte170m` only in the transfer member while primaries, matrix, and limited
  range remain exact, because the normative WebCodecs definition says those
  transfer functions are functionally the same; and
- the already-supported browser sRGB transfer normalization under its existing
  narrow shape, retained as a named compatibility rule.

It continues to reject:

- full-range YUV presented as limited-range YUV;
- conflicting primaries or matrix coefficients;
- PQ, HLG, linear, or other concrete transfer changes;
- partial/null metadata when a strict concrete expectation is required; and
- every tuple not covered by an explicit semantic rule.

The decoder attaches the classification to its validation decision while the
existing diagnostics continue to retain the exact expected and observed arrays.
No Android, Chrome, Samsung, Pixel, AV1, or VP9 branch is added.

## 6. Compiler-authored Packed-alpha Witness

### 6.1 Format

Add an optional, versioned output-qualification witness to packed-alpha
renditions. Legacy assets without a witness remain readable, but new compiler
output emits one whenever the initial readiness set contains robust alpha
samples. Certification requires witnesses for every packed-alpha example.

The witness is bounded:

```ts
interface PackedAlphaWitnessV1 {
  readonly kind: "packed-alpha-v1";
  readonly unit: string;
  readonly frame: number;
  readonly samples: readonly Readonly<{
    readonly x: number;
    readonly y: number;
    readonly expected: "transparent" | "opaque";
  }>[];
}
```

- The compiler emits exactly two through eight samples.
- Coordinates address logical alpha-pane pixels, not coded padding.
- Transparent samples come from stable neighborhoods whose canonical alpha is
  at most 8.
- Opaque samples come from stable neighborhoods whose canonical alpha is at
  least 247.
- The compiler chooses samples deterministically by source/unit/frame and
  row-major coordinate.
- A witness must contain at least one transparent and one opaque sample.
- If no initial-readiness frame has both robust classes, compilation may omit
  the optional witness, but compatibility certification rejects the resulting
  packed-alpha example until an author supplies certifiable startup content.

The runtime accepts a transparent decoded sample at or below 32 and an opaque
sample at or above 223. These thresholds tolerate bounded lossy ringing while
remaining far apart. They are format constants with compiler and runtime tests,
not tunable browser exceptions.

### 6.2 Runtime proof

During provisional startup, the shared renderer controller materializes the
witness frame to sRGB RGBA once through the existing timed, exact
`VideoFrame.copyTo()` contract. It samples the alpha pane's red channel using
the rendition geometry and the witness coordinates.

The candidate is qualified only when every witness sample matches its class.
A mismatch produces a typed decoded-output failure before `visualReady` or
`interactiveReady`. Because the witness is compared with authored semantics,
it catches corruption shared by native texture upload and RGBA copy.

The same materialized bytes may be reused for the candidate's first upload.
The proof does not add an unbounded frame copy, retain media bytes in
diagnostics, or inspect arbitrary later frames.

## 7. Renderer Architecture

The current `renderer.ts` and `canvas2d-renderer.ts` are parallel runtimes.
Before adding output qualification, extract one renderer controller that owns:

- operation serialization and pending counts;
- stream-slot and resident-frame identity;
- `VideoFrame` geometry validation and RGBA materialization;
- copy timeout and in-flight accounting;
- witness qualification;
- common resize/redraw scheduling;
- lifecycle state, context-change routing, terminalization, and disposal;
- common budget accounting and snapshot fields; and
- stable renderer diagnostics.

Backend interfaces own only platform primitives and backend-specific resources:

```ts
interface RendererBackend {
  readonly kind: "webgl2" | "canvas2d";
  configure(layout: RenderLayout, presentation: RendererPresentation): void;
  allocateResident(key: string): void;
  upload(target: RendererTarget, source: RendererRgbaSource): Promise<void>;
  draw(target: RendererTarget, viewport: RendererViewport): void;
  releaseResident(key: string): void;
  backendSnapshot(): RendererBackendDetails;
  dispose(): void;
}
```

The WebGL2 backend retains texture/program/native-upload logic and its bounded
native-versus-reference probe. The Canvas2D backend retains scratch surfaces,
`putImageData`, scaling, and `destination-in` composition. Neither backend owns
codec selection, queueing, generic frame validation, copy timeouts, readiness,
or duplicated public diagnostics.

Use `@pixel-point/aval-format` as the canonical authority for packed-alpha
geometry and `PACKED_ALPHA_GUTTER`; do not retain a second hard-coded eight-pixel
definition.

Snapshots expose common fields plus a discriminated `backendDetails` union.
Canvas2D no longer fills WebGL-only fields with artificial zero literals.

## 8. Typed Candidate Rejection

Introduce one internal startup result:

```ts
interface StartupCandidateRejection {
  readonly disposition: "retry-next-candidate" | "terminal";
  readonly stage: "probe" | "decode" | "output" | "renderer";
  readonly cause:
    | "unsupported-config"
    | "decoder-operation"
    | "decoded-metadata-incompatible"
    | "decoded-output-incompatible"
    | "renderer-unavailable"
    | "terminal-runtime";
}
```

The decoder, output witness, and renderer create this result at their ownership
boundary. Source selection consumes the disposition directly. Detailed
diagnostics remain evidence and are no longer parsed to decide whether a source
is retryable.

`decoded-output-incompatible` is retryable only during provisional
qualification. If every authored source returns a retryable rejection, the
generation terminates through the existing public typed error. Renderer
backend selection remains within one source candidate: exact-null WebGL2 may
select Canvas2D, but a renderer backend failure never advances the codec ladder.

## 9. Firefox Policy

Do not add a Firefox-specific runtime fix or fallback decoder in this cycle.

- Firefox 152, 151, 150, and 130 are positive Windows 11 matrix slots.
- Firefox 129 and 128 are negative sentinels and must produce exactly one
  `unsupported-profile` failure with no hang, blank nonterminal canvas, or
  AVAL-owned fallback.
- Firefox for Android remains separately uncertified until its WebCodecs and
  codec matrix is measured on real devices.

Public browser-support documentation states the Firefox 130 feature floor and
the one-release exception to a literal 24-month promise.

## 10. Testing and Evidence

### 10.1 Test-first regressions

- Pure table tests for exact BT.709, the captured SMPTE-170M transfer
  normalization, the existing sRGB normalization, and every conflicting member.
- Decoder integration tests prove the captured Android tuple succeeds while
  diagnostics still preserve raw expected/observed arrays on a true mismatch.
- Format/compiler tests prove deterministic bounded witness selection and
  rejection of malformed coordinates, counts, classes, and geometry.
- Renderer-controller tests prove the witness runs once before publication,
  reuses materialized bytes, retries the next candidate on mismatch, and is
  identical across WebGL2 and Canvas2D.
- Candidate-selection tests prove AV1 -> VP9 -> HEVC -> H.264, including a
  corrupt AV1 witness followed by successful VP9, and terminal exhaustion with
  no static fallback.
- Missing-WebCodecs tests prove one typed Firefox-boundary
  `unsupported-profile` result.

### 10.2 Local verification

Run focused tests after each extraction, then:

```bash
npm run typecheck
npm run build
npm run test:unit
npm run test:playground
npm run test:grass-rabbit
npm run test:grass-rabbit-codecs
npm run test:kinetic-orb
node scripts/browser-compatibility/validate-example-assets.mjs
```

Run the thermo-nuclear maintainability review after the controller/backend
split and again after the final implementation. Block release on new giant
modules, duplicated lifecycle branches, codec-name exceptions, or diagnostic
shape parsing used as control flow.

### 10.3 BrowserStack verification

Use the signed-in BrowserStack Live session and one immutable tunnel snapshot.
Save platform/demo/result screenshots and diagnostic JSON under a commit- and
timestamp-keyed evidence directory.

- Android: Galaxy S24 / Android 14 and Pixel 9 / Android 15, all four demos,
  direct AV1/VP9/HEVC/H.264 controls, interactions, and a 60-second soak.
- Firefox on Windows 11: 152/151/150/130 positive; 129/128 negative.
- Chrome on Windows 11: current/previous/previous-two and the 24-month sentinel.
- Safari on real iPhone: current provider versions plus iOS 18 boundary; verify
  HEVC is selected before H.264 when AV1 and VP9 are unavailable.

Passing evidence requires correct pixels and interaction, not merely a
readiness string. H.264 evidence is valid only when AV1, VP9, and HEVC were
shown unavailable or failed qualification first.

## 11. Delivery Boundaries

This cycle may change internal renderer, decoder, format, compiler, diagnostics,
example assets, tests, and browser-support documentation. It does not add a
legacy decoder backend for Firefox 129 or earlier, add AVAL-owned fallback
content, or promise untested Brave results. Branded Brave remains a separate
matrix slot and cannot be inferred from Chrome.
