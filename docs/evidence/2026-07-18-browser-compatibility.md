# Browser compatibility audit — 2026-07-18

This is a manual pre-fix audit of the public examples through an ephemeral
Cloudflare tunnel in signed-in BrowserStack Live sessions. It records runtime
diagnostics rather than treating a blank canvas, spinner, or support probe as a
result. The tunnel and local servers were stopped after the run.

No screenshot is claimed as evidence: BrowserStack screenshot capture timed
out, and the canvas capture workflow did not produce a downloadable artifact.

## Results

| Platform/session | Example and source | Observed result |
| --- | --- | --- |
| iPhone / Mobile Safari 26.5, 26.4, 26.0 | Kinetic Orb, H.264 | Passed: `interactiveReady`, no fatal failure, selected `avc1.64001E`. |
| iPhone / Mobile Safari 26.5, 26.4, 26.0 | End-user and Grass Rabbit, AV1 | Failed after a positive configuration probe with one canonical `worker-decode-failure` / `EncodingError`; readiness became `error` and player, decoder, and byte ownership retired to zero. |
| iPhone / Mobile Safari selected as iOS 18.0 | Same representative checks | BrowserStack actually reported iOS 18.6. H.264 passed; AV1 produced the same canonical runtime failure. This is not exact iOS 18.0 evidence. |
| Galaxy S25 / Android 15, Chrome session reporting 145 | End-user, small AV1 | Passed and responded to interaction. |
| Galaxy S23 / Android 13, Chrome session reporting 145 | End-user, small AV1 | Passed. |
| Galaxy S25 / Android 15 and Galaxy S23 / Android 13 | Grass Rabbit packed AV1; Kinetic Orb packed H.264 | Failed at decoder output validation with `worker-decode-failure`, diagnostic code `invalid-output`, and unexpected decoded-frame geometry. |
| Galaxy S26 / Android 16 | Launch only | BrowserStack did not expose DevTools for this device, so no exact runtime result is claimed. |
| Windows 11 / Chrome 150 | Grass Rabbit and Kinetic Orb | Failed canonically with `renderer-failure` during `prepare`. |
| Windows 11 / Chrome 149 and 148 | Kinetic Orb | Failed with the same `renderer-failure` during `prepare`. |
| Windows 11 / Chrome 127 | Kinetic Orb H.264 and Grass Rabbit AV1 | No fatal error was observed after more than 20 seconds and keyboard/pointer interaction; classified only as likely pass because the session lacked the same diagnostic instrumentation. |

BrowserStack's Android sessions exposed a reduced user agent
(`Android 10; K`, Chrome 145) even when Android 13 or 15 was selected. The
device/OS selection and observed user agent are therefore retained separately.

## Compatibility target

- Maintain a rolling 24-month support window.
- Certify the current, previous, and previous-2 shipping versions plus one
  explicit boundary version; do not use moving aliases as evidence.
- Require an authored 8-bit 4:2:0 H.264 rendition as the compatibility floor.
- Treat AV1, VP9, and HEVC as optimizations only after the selected source has
  produced and validated a real first frame. A positive codec configuration
  probe is preliminary evidence, not playback qualification.
- Keep alternate UI consumer-owned. AVAL publishes one canonical terminal
  error and performs bounded cleanup; it does not install or reveal a static
  fallback.

## Fix order derived from the audit

1. Add runtime source qualification/failover: retire a candidate that fails
   decoder startup or output validation and try the next authored rendition in
   the same source generation. Publish a fatal error only after all authored
   candidates are exhausted. This is source failover, not UI fallback.
2. Fix Android packed-frame geometry handling. Preserve output validation and
   either normalize platform `VideoFrame` geometry/metadata or adapt the
   packed-alpha validator to the proven Android representation.
3. Reproduce the Windows renderer `prepare` failure outside BrowserStack's GPU
   environment, then isolate WebGL2, transferable canvas/context, and GPU
   blocklist behavior before classifying it as a Chrome product regression.
4. Keep the exact version/build/channel matrix and fatal-error-boundary witness
   in release certification so unsupported or inconclusive slots cannot be
   summarized as passing.
