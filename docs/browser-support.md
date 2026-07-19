# Browser support

Functional CI uses pinned Playwright engines for fast browser-path coverage; it
is not branded-browser certification. Each release targets a rolling 24-month
matrix: Windows 11 stable-channel Chrome current/current-1/current-2 plus the
stable build closest to the boundary, the three latest current-generation
Mobile Safari point releases
plus the previous iOS major closest to the boundary, and a real Android 15
device with an exactly observed Chrome version. Android 16 remains a diagnostic
target until the provider exposes enough browser identity and DevTools evidence
to bind a result to an exact version. iOS 17 and Android 14 are useful
beyond-policy diagnostics, not release requirements. The generated table below
records evidence only after named-profile reports have been committed. Durable
profile evidence retains the exact browser version, build, and release channel;
a beta, development, or custom channel cannot satisfy a stable slot.
Browser builds are numeric dotted identifiers, never labels such as `latest`.
For Chrome, Microsoft Edge, and Firefox, the build's leading component must
match the reported product-version major. Safari and Mobile Safari retain the
independently reported numeric WebKit/Safari build identifier instead of
pretending that it shares the marketing-version major.

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
Network, CORS/CSP, integrity, malformed-asset, worker transport,
WebGL/resource, renderer/context, cleanup, abort, and watchdog failures remain
terminal for that generation. They reject `prepare()` with
`AvalPlaybackError` and raise one fatal `error` event; the application decides
how to respond. Within a file, renditions remain in authored quality order.
After `interactiveReady`, a fatal decoder failure is terminal and never
re-enters source selection. The runtime never silently changes canvas size,
frame rate, or active codec.

H.264 8-bit 4:2:0 is the mandatory compatibility rendition and should use the
minimum practical profile and level for the asset. AV1, VP9, and H.265/HEVC are
optional efficiency paths and are reported as playable only after production
qualification succeeds. Authors normally place them before H.264 in preferred
order; source order, not a hardcoded codec ranking, defines the ladder. Ten-bit
AV1 is not a baseline requirement.

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
