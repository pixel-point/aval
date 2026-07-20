# Browser Output Qualification Design

**Date:** 2026-07-20

**Status:** Approved by the user's earlier instruction to continue autonomously
with the recommended compatibility approach; refined after the 2026-07-20
thermo-nuclear maintainability checkpoint.

**Decision:** Treat browser-reported color metadata through one typed semantic
classifier, prove decoded packed-alpha output against a compiler-authored and
encoded-rendition-verified bounded witness before publishing readiness, and let
the provisional-startup orchestrator map typed local failures into a closed
retryable-candidate union. Keep semantic qualification outside one renderer
controller with small WebGL2 and Canvas2D backends.

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

Arbitrary consumer source arrays remain authored-order inputs and are never
silently re-sorted. First-party examples and certification fixtures must emit
and assert the exact order above. H.264 must never be opened, probed, fetched,
or decoded after HEVC succeeds, and it is touched only after every preceding
authored candidate records a retryable provisional failure.

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
Firefox 130. No Firefox-specific branch is justified. Firefox 130 is the
candidate feature floor until AVAL itself passes the recorded BrowserStack
matrix; Firefox 129 and 128 remain required negative sentinels.

## 3. Non-negotiable Contracts

- Authored source order is the only codec-priority policy.
- Shipped examples enforce `AV1 -> VP9 -> HEVC/H.265 -> H.264`; the runtime
  preserves arbitrary consumer order instead of pretending it is a rank.
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
- A packed-alpha rendition without a valid witness is not playback-qualified:
  malformed data is a terminal asset error and a legacy missing witness is a
  terminal unsupported-profile result, never a reason to try another codec.

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
whose samples are rechecked against the exact emitted bitstream. A provisional
`DecodedOutputQualifier` performs the bounded semantic check before handing the
frame to the renderer. Candidate selection consumes a closed typed outcome
created only by the provisional-startup orchestrator.

The selected approach costs one bounded startup RGBA materialization plus one
compiler decode-validation pass for each emitted packed-alpha rendition and
requires regenerated example assets, but it is capability-based,
deterministic, testable, and independent of browser names.

## 5. Color-space Classification

Create one DOM-independent color module in `@pixel-point/aval-format` that owns
all semantic comparison. Both `@pixel-point/aval-element` and the retained
`@pixel-point/aval-player-web` worker consume it through thin WebCodecs tuple
adapters; no second matcher remains. It returns a discriminated result instead
of a boolean:

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
- the browser sRGB transfer normalization only for the exact tuple
  `["bt709", "iec61966-2-1", "bt709", false]`, retained as a named
  compatibility rule. Full-range sRGB is explicitly incompatible.

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

Bump the asset wire/header minor and manifest version to `1.1`. Format readers
dispatch explicitly: legacy `1.0` assets keep their original exact-key schema,
while `1.1` adds `outputQualification` and requires it on every packed-alpha
rendition. This avoids silently changing the meaning of strict `1.0`.

The current parser can still inspect legacy `1.0` assets, but packed-alpha
playback has a stricter qualified profile: a legacy missing witness is a
terminal unsupported-profile failure. A malformed `1.1` witness is a terminal
invalid-asset failure. Neither condition is codec-retryable. New compilation
always emits `1.1`, fails if it cannot emit a qualified witness, and all
first-party examples are regenerated. The element's independent exact-key
asset reader is an unconditional part of this versioned migration.

The witness is bounded:

```ts
interface PackedAlphaWitnessV1 {
  readonly kind: "packed-alpha-v1";
  readonly unit: string;
  readonly frame: number;
  readonly samples: readonly Readonly<{
    readonly x: number;
    readonly y: number;
    readonly expectedRange: readonly [minimum: number, maximum: number];
  }>[];
}
```

- The compiler emits one through eight samples. Valid content is not required
  to contain both fully transparent and fully opaque pixels.
- Coordinates are local visible-alpha-rendition pixels. Runtime addressing
  adds `alphaRect.x` and `alphaRect.y`; coded padding and gutter coordinates are
  never authorable.
- Every inclusive expected interval is bounded to `0..255`, has width at most
  96, and contains both canonical source alpha `c` and compiler-decoded emitted
  alpha `e`. After requiring `abs(c - e) <= 32`, construction is exact:
  `[max(0, min(c, e) - 32), min(255, max(c, e) + 32)]`. Transparent/opaque
  samples naturally produce narrow clipped edge intervals, while uniformly
  opaque, uniformly transparent, or mid-alpha content remains compilable.
- The compiler chooses samples deterministically by unit/frame, low local
  gradient, then row-major coordinate. Coordinates are unique. When the chosen
  frame contains canonical alpha values separated by at least 128, the witness
  includes two samples with non-overlapping expected intervals; otherwise one
  representative sample is valid.
- `frame` is the zero-based local presentation index inside `unit`, must be less
  than that unit's `frameCount`, and is not a global decode ordinal. The unit
  must be in `readiness.bootstrapUnits` and contain a chunk span for the selected
  rendition. Manifest relation validation enforces all three references.
- After encoding, the compiler decodes the exact emitted rendition and retains
  only candidates whose decoded alpha-pane red value differs from canonical
  alpha by at most 32. It applies the exact min/max-plus-32 formula above. If no
  meaningful bounded sample survives in the readiness span, compilation fails
  with an actionable qualification error.

The interval width and maximum compiler-reference delta are format constants
with compiler and runtime tests, not tunable browser exceptions.

### 6.2 Runtime proof

During provisional startup, the startup orchestrator schedules the witness
unit/frame before publication, including prerequisite chunks from the nearest
random-access point. It passes the already-decoded target frame and its explicit
unit/local-presentation identity to `DecodedOutputQualifier`. The qualifier
validates that identity, materializes the frame to sRGB RGBA once through a
shared bounded materializer, then samples the alpha pane's red channel using
canonical rendition geometry and local witness coordinates.

The materializer first uses the existing timed, exact
`VideoFrame.copyTo({ format: "RGBA" })` contract. An ordinary unsupported-copy
result may use one bounded Canvas2D `drawImage`/`getImageData` readback. Timeout,
unsafe layout, taint/security failure, context failure, or inability to obtain
CPU pixels is a terminal materializer/browser-capability failure and never
advances the codec ladder.

The candidate is qualified only when every witness sample lies inside its
inclusive expected interval.
A mismatch produces a typed decoded-output failure before `visualReady` or
`interactiveReady`. Only this semantic mismatch is eligible for provisional
codec retry. Rejected resources and unpublished readiness state are fully
retired before the successor opens. Because the witness is compared with the
decoded emitted rendition, it catches corruption shared by native texture
upload and RGBA copy.

Canvas2D's first upload and WebGL2's RGBA reference probe may reuse the cached
materialized bytes. WebGL2's primary upload remains the native `VideoFrame` and
does not pretend to consume the cached bytes.
The proof is deliberately limited to decoded packed-alpha semantics; shader
coordinates, Y-flip, premultiplication, blending, Canvas composition, scaling,
and the final framebuffer remain backend-conformance and real-device visual
evidence responsibilities. The proof does not add an unbounded frame copy,
retain media bytes in diagnostics, or inspect arbitrary later frames.

## 7. Renderer Architecture

The current `renderer.ts` and `canvas2d-renderer.ts` are parallel runtimes.
Before adding output qualification, extract one renderer controller that owns:

- operation serialization and pending counts;
- stream-slot and resident-frame identity;
- `VideoFrame` geometry validation and RGBA materialization;
- copy timeout and in-flight accounting;
- common resize/redraw scheduling;
- lifecycle state, context-change routing, terminalization, and disposal;
- common budget accounting and snapshot fields; and
- stable renderer diagnostics.

Semantic witness policy is not a renderer responsibility. The controller may
share the bounded RGBA materializer with `DecodedOutputQualifier`, but it does
not interpret witness unit/frame/sample semantics.

Backend interfaces own only platform primitives and backend-specific
resources. Targets are opaque handles, uploads expose a native frame plus a
lazy bounded RGBA reference, and context state flows through an explicit event
sink:

```ts
interface RendererBackendTarget {
  readonly rendererBackendTarget: unique symbol;
}

interface RendererUploadSource {
  readonly frame: VideoFrame;
  rgba(): Promise<RendererRgbaSource>;
}

interface RendererBackend {
  readonly kind: "webgl2" | "canvas2d";
  setEventSink(sink: (event: RendererBackendEvent) => void): void;
  configure(layout: RenderLayout, presentation: RendererPresentation): void;
  allocateTarget(): RendererBackendTarget;
  upload(target: RendererBackendTarget, source: RendererUploadSource): Promise<void>;
  draw(target: RendererBackendTarget, viewport: RendererViewport): void;
  releaseTarget(target: RendererBackendTarget): void;
  backendSnapshot(): RendererBackendDetails;
  dispose(): void;
}
```

The WebGL2 backend retains texture/program/native-upload logic and its bounded
native-versus-reference probe; it invokes the lazy RGBA reference only when the
probe or fallback path requires it. The Canvas2D backend invokes the same lazy
reference and retains scratch surfaces, `putImageData`, scaling, and
`destination-in` composition. Neither backend owns authored identity, codec
selection, queueing, generic frame validation, copy timeouts, readiness, or
duplicated public diagnostics.

Use `@pixel-point/aval-format` as the canonical authority for packed-alpha
geometry and `PACKED_ALPHA_GUTTER`; do not retain a second hard-coded eight-pixel
definition.

Snapshots expose common fields plus a discriminated `backendDetails` union.
Canvas2D no longer fills WebGL-only fields with artificial zero literals.

## 8. Typed Candidate Rejection

Before changing retry policy, extract provisional selection/qualification from
the 3,000-line player into a focused `provisional-startup.ts` orchestrator and
extract reusable candidate/WebCodecs fakes from the 1,400-line source-fallback
test. `player.ts` must shrink in net lines. New production targets are bounded:
provisional orchestrator at 500 lines, renderer controller at 700, RGBA
materializer and decoded-output qualifier at 350 each, and each backend at 900.
The reusable test harness target is 400 lines. Exceeding a target requires a
thermo-nuclear design review before more behavior is added.

Decoder, qualifier, and renderer boundaries return typed local failures without
choosing codec policy. Only the provisional-startup orchestrator can construct
a retryable candidate outcome. Invalid retry/stage/cause combinations are not
representable:

```ts
type RetryableCandidateRejection =
  | { readonly stage: "probe"; readonly cause: "unsupported-config" }
  | { readonly stage: "configure"; readonly cause: "configure-not-supported" }
  | { readonly stage: "decode"; readonly cause: "decode-not-supported" }
  | { readonly stage: "decode"; readonly cause: "decode-encoding-rejected" }
  | { readonly stage: "flush"; readonly cause: "flush-not-supported" }
  | { readonly stage: "flush"; readonly cause: "flush-encoding-rejected" }
  | { readonly stage: "decode"; readonly cause: "decoded-metadata-incompatible" }
  | { readonly stage: "output"; readonly cause: "decoded-output-incompatible" };

type ProvisionalCandidateOutcome<T> =
  | { readonly kind: "selected"; readonly value: T }
  | { readonly kind: "retryable-rejection"; readonly rejection: RetryableCandidateRejection };

type TerminalStartupFailure =
  | RendererFailureError
  | MaterializerFailureError
  | AssetFailureError
  | ResourceFailureError
  | CleanupFailureError
  | AbortFailureError;
```

The orchestrator uses an exhaustive decoder-local failure mapping table for the
variants above and the one qualifier mismatch. Resource, timeout, abort,
transport, malformed stream/asset, integrity, policy, cleanup, renderer, and
materializer failures have no entry and therefore cannot become retryable.
Every other failure is terminal and thrown through its existing typed public
path. Detailed diagnostics remain evidence and are no longer parsed to decide
whether a source is retryable.

`decoded-output-incompatible` is retryable only during provisional
qualification. If every authored source returns a retryable rejection, the
generation terminates through the existing public typed error. Renderer and
materializer failures cannot inhabit the retryable union. Renderer backend
selection remains within one source candidate: exact-null WebGL2 may select
Canvas2D, but a renderer backend failure never advances the codec ladder.

## 9. Firefox Policy

Do not add a Firefox-specific runtime fix or fallback decoder in this cycle.

- Firefox 152, 151, 150, and 130 are positive Windows 11 matrix slots.
- Firefox 129 and 128 are negative sentinels and must produce exactly one
  `unsupported-profile` failure with no hang, blank nonterminal canvas, or
  AVAL-owned fallback.
- Firefox for Android remains separately uncertified until its WebCodecs and
  codec matrix is measured on real devices.

Before real-device qualification, public browser-support documentation states
Firefox 130 as the candidate feature floor and the one-release exception to a
literal 24-month promise. It may be promoted to certified only after the
Firefox 130 AVAL pixel/interaction run passes.

## 10. Testing and Evidence

### 10.1 Test-first regressions

- Pure table tests for exact BT.709, the captured SMPTE-170M transfer
  normalization, the existing sRGB normalization, and every conflicting member.
- Decoder integration tests prove the captured Android tuple succeeds while
  diagnostics still preserve raw expected/observed arrays on a true mismatch.
- Format/compiler tests prove deterministic bounded witness selection, exact
  interval endpoints, exact-emitted-rendition survival, terminal
  missing/malformed handling, and rejection of malformed coordinates, counts,
  intervals, references, and geometry.
- Qualifier/materializer tests prove the witness runs once before publication,
  reuses materialized bytes, rejects CPU-materialization failure terminally,
  and presents identical qualified bytes to WebGL2 and Canvas2D.
- Candidate-selection tests prove AV1 -> VP9 -> HEVC -> H.264, including a
  corrupt AV1 witness followed by successful VP9, and terminal exhaustion with
  no static fallback. They also prove HEVC success never touches H.264 and no
  candidate after a winner is opened, probed, fetched, or decoded.
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
- Brave on Windows 11: attempt current/previous/previous-two branded builds;
  retain provider-unavailable evidence instead of inferring from Chrome.
- Safari on real iPhone: attempt iOS 26.5, 26.4, and 26.3 plus the iOS 18.0
  boundary; retain provider provisioning failures as explicit coverage gaps.
  Verify HEVC is selected before H.264 when AV1 and VP9 are unavailable.

Passing evidence requires correct pixels and interaction, not merely a
readiness string. Save attempt diagnostics beside screenshots. H.264 evidence
is valid only when AV1, VP9, and HEVC were shown unavailable or failed
qualification first; HEVC success evidence must show H.264 was untouched.

## 11. Delivery Boundaries

This cycle may change internal renderer, decoder, format, compiler, diagnostics,
example assets, tests, and browser-support documentation. It does not add a
legacy decoder backend for Firefox 129 or earlier or add AVAL-owned fallback
content. Legacy packed-alpha manifests remain parseable for inspection, but
without a witness they are outside the playback-qualified profile and fail
terminally. Branded Brave remains a separate attempted matrix slot and cannot
be inferred from Chrome; provider unavailability is reported as a gap rather
than a product pass.
