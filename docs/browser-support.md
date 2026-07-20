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

Firefox 130 is the oldest certified desktop playback release. It is the first
stable desktop Firefox release with AVAL's required WebCodecs interfaces.
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

The player evaluates direct-child sources in author order. It validates each
required codec hint and probes every otherwise-eligible authored rendition
with `VideoDecoder.isConfigSupported()` inside the same module-worker
environment used for decoding. A positive configuration probe is only
preflight; production qualification must also decode, transfer, validate, and
present a real initial frame. It does not sniff the user agent or call media
element `canPlayType()`.

A deterministically unsupported codec/configuration advances to the next
authored rendition or source. A pre-commit decoder failure also advances when
its bounded diagnostic evidence identifies a codec qualification failure:
unsupported configuration, invalid decoded output, or an `EncodingError`/
`NotSupportedError` during configure, decode, flush, or output validation.
One renderer qualification failure also advances before commit: an exact,
candidate-scoped `NotSupportedError` from the RGBA-copy runtime path with no GL,
context-loss, or cleanup failure. Network, CORS/CSP, integrity, malformed-asset,
worker transport, every other WebGL/resource or renderer/context failure,
cleanup, abort, and watchdog failures remain terminal for that generation. They
reject `prepare()` with `AvalPlaybackError` and raise one fatal `error` event;
the application decides how to respond. Within a file, renditions remain in
authored quality order.
After `interactiveReady`, a fatal decoder failure is terminal and never
re-enters source selection. The runtime never silently changes canvas size,
frame rate, or active codec.

H.264 8-bit 4:2:0 is the mandatory last-resort rendition and should use the
minimum practical profile and level for the asset. The supported reference
contract and bundled examples publish the exact order AV1 → VP9 → H.265/HEVC →
H.264. H.264 is selected only after every earlier authored candidate is
deterministically unsupported or fails the narrow startup qualification above;
certification rejects an H.264 selection without candidate-scoped proof for
each skipped modern codec. Source order remains the public preference contract,
so custom markup that places H.264 first explicitly opts out of this ladder.
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
