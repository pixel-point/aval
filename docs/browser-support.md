# Browser support

Functional CI uses pinned Playwright engines for fast browser-path coverage; it
is not branded-browser certification. Each release targets a rolling 24-month
matrix: Windows 11 stable-channel Chrome and desktop Firefox
current/current-1/current-2, Chrome's stable build closest to the boundary,
the Firefox feature floor described below, the three latest current-generation
Mobile Safari point releases plus the previous iOS major closest to the
boundary, and real Android 17, 16, and 15 devices with exactly observed Chrome
versions. The signed-in
BrowserStack sessions report Chrome/Chromium 145.0.0.0 for both Pixel 9 slots
and the Samsung Galaxy S25 slot. iOS 17 and Android 14 are useful
beyond-policy diagnostics, not release requirements. The generated table below
records evidence only after named-profile reports have been committed. Durable
profile evidence retains the exact browser version, build, and release channel;
a beta, development, or custom channel cannot satisfy a stable slot.
Browser builds are numeric dotted identifiers, never labels such as `latest`.
For Chrome, Microsoft Edge, and Firefox, the build's leading component must
match the reported product-version major. Safari and Mobile Safari retain the
independently reported numeric WebKit/Safari build identifier instead of
pretending that it shares the marketing-version major.

Firefox 130 is the candidate desktop playback floor pending recorded AVAL
BrowserStack qualification. It is the first stable desktop Firefox release
with AVAL's required WebCodecs interfaces, but API availability alone is not a
compatibility pass.
Firefox 129 is a one-release feature-floor exception. It remains inside the
literal 24-month promise on 2026-07-20 but predates desktop WebCodecs. Firefox
128 and 129 are mandatory negative sentinels: they must terminate preparation
once with `unsupported-profile`, never hang or publish a blank nonterminal
canvas, and never cause AVAL to render fallback content. Supporting those
releases would require a different decoder backend; applications decide how to
respond to the typed error. Firefox for Android remains uncertified until it is
measured independently, and desktop Firefox results are never relabeled as
Android evidence.

Desktop Safari certification uses only provider-observable versions: Safari
26.4 on macOS Tahoe and Safari 18.4 on macOS Sequoia in the signed-in
BrowserStack inventory checked on 2026-07-19. Safari 26.3, 26.2, 18.3, and 18.2
were not offered for those desktop OS profiles and therefore are not represented
by synthetic or relabeled slots. The three-latest requirement applies to the
real-device Mobile Safari 26.5, 26.4, and 26.0 slots.

BrowserStack Live Device Info and screenshots are manual operator evidence,
not formal automated certification. A formal run starts by writing immutable
`run-identity.json`, captures through a real BrowserStack Automate/Playwright
page with the exact provider session id, and lets the evidence assembler create
`manifest.json` only after the raw policy-exact tree is complete. When Automate
credentials or that page session are unavailable, the formal matrix remains
pending; manual Live screenshots are never assigned invented session ids or
reported as machine-verifiable captures.

Repository-local evidence commands import the built canonical codec authority.
After a clean `npm ci --ignore-scripts`, build `@pixel-point/aval-graph`,
`@pixel-point/aval-format`, and `@pixel-point/aval-element` before running the
Brave matrix, evidence assembler, or evidence validator directly.

The player evaluates direct-child sources in the fixed AV1 → VP9 → H.265 →
H.264 family order declared by required `data-codec` attributes; DOM order is
irrelevant. It validates each family declaration and probes every
otherwise-eligible authored rendition
with `VideoDecoder.isConfigSupported()` inside the same module-worker
environment used for decoding. A positive configuration probe is only
preflight; production qualification must also decode, transfer, validate, and
present a real initial frame. It does not sniff the user agent or call media
element `canPlayType()`.

A deterministically unsupported codec/configuration advances to the next
authored rendition or codec family. During provisional startup, only the closed
typed decoder cases—unsupported configuration and explicit `NotSupportedError`
or `EncodingError` from configure, decode, or flush, or a decoder-local codec
support-probe, decode, or flush progress timeout—plus decoded metadata mismatch
and a wire-1.1 packed-alpha witness mismatch may advance. Diagnostics retain
evidence but are never parsed to reconstruct this policy.

Renderer and RGBA-materializer failures are terminal, including an unsupported
`VideoFrame.copyTo({ format: "RGBA" })` followed by an unavailable or failed
Canvas2D readback. Network, CORS/CSP, integrity, malformed assets, unsupported
wire versions, worker transport, resources, contexts, cleanup, abort, and
non-decoder watchdog failures are also terminal. They reject `prepare()` with
`AvalPlaybackError` and raise one fatal `error` event; the application decides
how to respond. Within a file, renditions remain in authored quality order.
After `interactiveReady`, a fatal decoder failure is terminal and never
re-enters source selection. The runtime never silently changes canvas size,
frame rate, or active codec.

H.264 8-bit 4:2:0 is the mandatory last-resort rendition and should use the
minimum practical profile and level for the asset. The supported reference
contract and bundled examples use the exact priority AV1 → VP9 → H.265/HEVC →
H.264. H.264 is selected only after every earlier present candidate is
deterministically unsupported or fails the narrow startup qualification above;
certification rejects an H.264 selection without candidate-scoped proof for
each skipped modern codec. Reordering markup cannot opt out of this ladder.
Normal iPhone certification requires HEVC or a higher-ranked selected codec;
an H.264 result is a failing HEVC-path investigation, not a support claim.
Ten-bit AV1 is not a baseline requirement.

<!-- BEGIN GENERATED SUPPORT -->
| Profile | Fatal error boundary | Runtime scheduling | Observed display |
| --- | --- | --- | --- |
| No named profiles | not run | not run | not measured |
<!-- END GENERATED SUPPORT -->

This table remains conservative until validated, digest-linked named reports
are committed. Runtime scheduling describes the browser-side content/deadline
ledger. Observed display requires a separate qualified scan-out trace or
calibrated external capture; RAF, decoder callbacks, GPU fences, canvas
submission, screenshots, and readback do not prove physical display continuity.
