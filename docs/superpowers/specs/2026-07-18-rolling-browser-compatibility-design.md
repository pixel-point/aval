# Rolling Browser Compatibility Design

**Date:** 2026-07-18

**Status:** Approved

**Decision:** AVAL owns deterministic playback qualification and structured
failure reporting. It does not generate, select, reveal, or otherwise own
fallback content. Applications decide how to respond to a failure.

## 1. Objective

AVAL must provide dependable interactive prerendered motion on a deliberately
bounded browser matrix while remaining honest on devices whose decoder or GPU
path cannot run an asset. The current implementation can report a codec as
supported after `VideoDecoder.isConfigSupported()` and then fail during actual
decoding or presentation. Some failures become blank canvases, generic errors,
or states that never visibly settle. These outcomes make a nominal capability
probe look like a compatibility guarantee when it is not one.

This design establishes a rolling 24-month compatibility policy and changes
runtime qualification from configuration-only probing to proof of the actual
decode-and-presentation path. It also establishes one public failure boundary
that gives applications enough stable information to implement their own
fallback behavior.

The implementation proceeds from captured evidence. It must not weaken strict
format, timing, geometry, color-space, integrity, or resource validation merely
to make a browser test pass.

## 2. Support Policy

### 2.1 Certified interactive tier

Every release is certified on these reference configurations:

- Windows 11 with the current, previous, and previous-two stable Chrome
  releases;
- the three latest current-generation Mobile Safari point releases on real
  iPhones, plus the previous iOS major closest to the 24-month boundary;
- Android 15 with the exactly observed Chrome installed by the device provider,
  including at least one Samsung or comparable mid-range device; Android 16 is
  a diagnostic target until the provider exposes exact browser identity and
  DevTools evidence; and
- an explicit desktop Chrome build closest to 24 months old as the Chromium
  engine-age sentinel.

The exact versions and device identities are recorded in release evidence.
Mobile Chrome support is stated by Android OS range plus the observed installed
Chrome version because remote real-device providers do not allow arbitrary
mobile Chrome downgrades.

A certified configuration must:

1. prepare and present the mandatory H.264 rendition;
2. render opaque and packed-alpha assets correctly;
3. complete authored state interactions and transitions;
4. remain bounded during decoder pressure and context loss;
5. report every optional codec truthfully; and
6. terminate failed operations with a structured public failure rather than a
   blank canvas, indefinite preparation, or misleading support state.

### 2.2 Compatibility boundary

The release also exercises the browser builds closest to the 24-month boundary,
currently Chrome 127, Safari/iOS 18, and Android 15. Full interaction is the
goal on the reference device. iOS 17 and Android 14 may be run as informational
beyond-policy diagnostics, but do not gate a release. A configuration that
cannot provide the required decoder or renderer path is still
compatibility-safe when AVAL terminates deterministically and raises the public
failure contract. AVAL itself does not display alternate content.

The policy does not imply that every hardware model, driver, codec accelerator,
or intervening monthly Chromium release is individually certified. It promises
the tested matrix, stable capability-based behavior, and deterministic failure
outside it.

### 2.3 Codec contract

H.264 is the mandatory compatibility rendition. Production bundles use 8-bit
4:2:0 output and the minimum practical profile and level for their dimensions
and frame rate. The compiler must not use an unnecessarily aggressive H.264
level as the universal compatibility candidate.

AV1, VP9, and H.265/HEVC are optional efficiency paths. Their absence never
makes an otherwise H.264-capable browser unsupported. Ten-bit AV1 is not a
baseline requirement. Optional codecs may be listed as playable only after the
same real qualification used for source selection succeeds.

## 3. Consumer-Owned Failure Boundary

AVAL owns playback, not fallback presentation.

The runtime must not:

- generate posters or static images;
- require a fallback slot;
- reveal, hide, or select consumer DOM as alternate content;
- render a built-in placeholder; or
- convert a playback failure into a claim that a static AVAL presentation is
  ready.

For a terminal capability or runtime failure, the element:

1. retires decoder, frame, renderer, scheduler, and page-resource ownership;
2. transitions the affected source generation to `error`;
3. dispatches one fatal `error` event carrying the stable failure code,
   operation, source/rendition context when available, and generation;
4. rejects the pending `prepare()` call with an error representing that same
   public failure; and
5. retains the failure in diagnostics until a newer source generation begins.

The rejected promise uses an exported `AvalPlaybackError`. It contains the
same frozen `AvalPublicFailure` value published in the fatal `error` event plus
the source generation. Its `name` is stable, its message is bounded, and callers
branch on `failure.code` rather than parsing text. The event and rejection are
published once for the terminal cause of that generation even if cleanup also
encounters errors; cleanup failures remain diagnostic unless they become the
only terminal cause.

Applications may respond by showing an image, another animation technology,
text, an empty state, or nothing. That policy remains entirely outside AVAL.

Nonfatal operational signals remain nonfatal. Superseded work rejects with
`AbortError`; visibility suspension and decoder admission waiting do not publish
a fatal compatibility failure. Reduced-motion policy remains a separate
accessibility condition and must not be mislabeled as decoder failure. This
compatibility effort does not prescribe the application's reduced-motion UI.

The legacy AVAL-managed fallback event and fallback-layer manipulation are
removed from the runtime contract. `staticReady`, where retained for a nonfatal
policy condition such as reduced motion or visibility suspension, means only
that animated resources are not active; it never means AVAL supplied or
revealed alternate content. Capability, decoder, renderer, and active-playback
failures terminate as `error`, not `staticReady`.

## 4. Playback Qualification

### 4.1 Preflight

`VideoDecoder.isConfigSupported()` remains a cheap, sequential preflight. A
negative result rejects that exact rendition. A positive result means only that
the browser recognizes the configuration; it does not prove the asset bytes,
decoder output, frame transfer, or renderer path.

### 4.2 Candidate proof

Before a source becomes the selected animated candidate, AVAL must use the
production worker, decoder configuration, validation, transfer, and renderer
path to:

1. inspect and submit the first independently decodable unit;
2. receive and validate the required initial decoded frames;
3. flush or otherwise prove unit completion under the normal watchdog;
4. transfer a real `VideoFrame` to the presentation owner;
5. upload it through the selected renderer path; and
6. complete one bounded presentation submission.

Only this result is called **playback qualified**. The proof is not a parallel
demo decoder and does not duplicate production logic.

Failure before qualification retires that candidate and advances to the next
authored codec source when the failure is codec-, decoder-, frame-, or
presentation-path specific. Network, integrity, malformed-format, and policy
failures retain their distinct codes and do not get disguised as codec
unavailability.

Once an animated candidate is qualified and published, AVAL does not hot-switch
codecs during active playback. A later fatal failure terminates the generation
through the consumer-owned failure boundary.

### 4.3 One compatibility authority

The public element, source selector, codec comparison example, diagnostics, and
release tests must consume the same qualification result. The codec comparison
UI may separately show a preflight outcome for diagnostics, but its user-facing
"playable" state requires production playback qualification.

The element and `player-web` packages must not maintain divergent definitions
of whether a source can play. Shared protocol/model code owns the result even if
the packages retain different lifecycle facades.

## 5. Diagnostic Evidence

The decoder-worker protocol must preserve enough sanitized evidence to locate a
failure without exposing asset bytes or URLs. A failure records:

- phase: `probe`, `configure`, `decode`, `flush`, `output-validation`,
  `frame-transfer`, `renderer-upload`, or `presentation`;
- stable runtime error code;
- sanitized exception name and bounded message when supplied by the browser;
- source index, rendition, codec, unit, generation, and decode ordinal when
  known; and
- for the first output frame, timestamp, duration, coded/display dimensions,
  visible rectangle, and color-space tuple.

The worker must not collapse every browser exception into an unqualified
`{ t: "error" }` event. Public errors remain intentionally smaller and stable;
the detailed evidence lives in diagnostics and retained test artifacts.

Instrumentation is bounded, byte-free, generation-scoped, and disabled from
unbounded accumulation. It records component boundaries rather than adding
console logging as runtime behavior.

## 6. Decoder and Transition Isolation

Foreground playback and candidate route decoding use two physical decoder
lanes. A candidate-lane failure before promotion must retire the candidate and
remain distinguishable from foreground failure. It must not silently poison a
healthy foreground lane or leave the graph reporting a transition that can no
longer present.

The BrowserStack evidence must determine whether Safari failures begin during
initial decode or only when route prefetch activates the second lane. If the
candidate lane fails, the graph and scheduler settle deterministically and the
public operation rejects with the preserved cause. The implementation must not
invent a concurrency workaround until that evidence confirms the failing
boundary.

## 7. Renderer Qualification and Recovery

Native `VideoFrame` to WebGL upload is an optimization, not a correctness
assumption. WebGL accepting `texSubImage2D` without an error does not prove that
the device produced correct pixels.

For each renderer/device session, a bounded semantic qualification compares a
known initial presentation result or pixel canary against the expected opaque
and packed-alpha layout. If native upload is invalid, the renderer permanently
selects the bounded `VideoFrame.copyTo(..., { format: "RGBA" })` path for that
renderer generation. It does not repeat an expensive probe per frame.

Context loss receives one bounded recreation attempt with exact resource
accounting. If recovery cannot requalify the renderer, the source generation
terminates through the public failure boundary. AVAL does not display fallback
content.

## 8. Verification and Release Gates

### 8.1 Per-change tests

Unit and Playwright tests cover:

- positive preflight followed by failed decode;
- failed candidate proof advancing to H.264;
- successful proof transferring ownership without duplicate decode;
- all-candidate exhaustion producing one public fatal failure;
- preservation of worker phase and first-frame metadata;
- candidate-lane failure isolation;
- native upload semantic failure selecting the RGBA copy path;
- context-loss recovery exhaustion;
- preparation rejection and error-event identity; and
- absence of AVAL-owned fallback DOM behavior.

Tests are written against a failing case before the implementation change.

### 8.2 Branded-browser release matrix

Playwright engine tests remain the fast CI gate but are not treated as branded
browser certification. Before release, BrowserStack or equivalent real-browser
evidence covers:

- Windows 11 Chrome current/current-1/current-2 and the 24-month sentinel;
- real iPhones for current, previous, and boundary Safari generations; and
- Android 15 on a real Samsung or comparable device; Android 16 joins the
  required matrix when the provider can bind exact browser identity and
  DevTools evidence, while Android 14 remains an optional beyond-policy
  diagnostic.

Each session verifies opaque H.264, packed-alpha H.264, interaction transitions,
optional-codec truthfulness, failure settlement, and resource cleanup. A single
blank canvas, corrupt alpha result, indefinite state, or false playable claim
fails that configuration.

The matrix is rerun after each root-cause fix. A release report records exact
browser, OS, device, selected codec, qualification outcome, and any structured
failure. Moving version aliases are not used as durable evidence.

## 9. Implementation Sequence

Work is intentionally split so each hypothesis remains testable:

1. remove AVAL-owned terminal fallback behavior from the compatibility
   contract and make public failure/rejection identity deterministic;
2. extend worker and element diagnostics without changing acceptance behavior;
3. rerun the failing browser matrix and identify the first failing component;
4. implement production-path candidate qualification and pre-qualification
   codec failover;
5. fix the confirmed Chrome decoder/output assumption;
6. isolate and fix the confirmed Safari decoder/concurrency boundary;
7. qualify native upload and fix Android packed-alpha rendering;
8. enforce the conservative H.264 compiler policy; and
9. install the rolling release matrix and publish the resulting support table.

Each root-cause fix has its own failing test and verification run. If three
independent fixes fail to resolve the same symptom, implementation stops and
the relevant architecture is reconsidered rather than accumulating another
workaround.

## 10. Non-Goals

This design does not:

- provide consumer fallback UI or fallback assets;
- promise that every optional codec works on every certified browser;
- add a user-agent allowlist or browser sniffing;
- add a WASM software decoder;
- support obsolete browsers outside the rolling policy;
- hot-switch codecs after qualified playback begins;
- weaken integrity, format, timing, geometry, color, or resource validation; or
- claim Playwright WebKit/Chromium results as Safari/Chrome certification.

## 11. Completion Criteria

The work is complete when:

1. current Chrome, Safari, and Android reference configurations qualify and
   interact through the mandatory H.264 path;
2. optional codecs are reported playable only after real qualification;
3. packed alpha is visually correct on the Android reference devices;
4. every terminal failure produces one actionable public error and rejected
   preparation with no AVAL-owned fallback presentation;
5. no tested failure leaves a blank-but-nonterminal or indefinitely preparing
   generation;
6. the 24-month sentinels either qualify or terminate through the same public
   failure contract; and
7. the branded-browser evidence and documented support matrix are committed for
   the release candidate.
