# Browser compatibility audit — 2026-07-18

This file records the manual 2026-07-18 pre-fix audit and a focused 2026-07-19
Rabbit follow-up. The remote-device checks used ephemeral Cloudflare HTTPS
tunnels and signed-in BrowserStack Live sessions. Results come from runtime
diagnostics rather than treating a blank canvas, spinner, or configuration
probe as evidence of playback.

No screenshot is claimed for the 2026-07-18 audit: BrowserStack screenshot
capture timed out, and the canvas capture workflow did not produce a
downloadable artifact.

## 2026-07-18 pre-fix results

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

## 2026-07-19 Rabbit follow-up

A fresh iPhone 16 / iOS 18 Safari real-device session tested the unmodified
four-source Grass Rabbit in authored AV1, VP9, HEVC, H.264 order over HTTPS.
Before the runtime change, Safari positively probed AV1 and then terminated
with `worker-decode-failure`; the retained decoder diagnostic was
`output-validation` / `invalid-output` for source 0. Isolating the same assets
in that HTTPS session produced these results:

| Authored source | Observed result |
| --- | --- |
| AV1 only | Failed with `worker-decode-failure` and the same `output-validation` / `invalid-output` evidence. |
| VP9 only | Passed: `interactiveReady`, selected `vp09.00.21.08.01.01.01.01.00`. |
| HEVC only | Passed: `interactiveReady`, selected `hvc1.1.6.L63.90`. |
| H.264 only | Passed: `interactiveReady`, selected `avc1.64001E`. |

### Post-fix BrowserStack checks

| Platform/session | Observed result |
| --- | --- |
| iPhone 16 / iOS 18 / Safari, HTTPS | AV1 source 0 retained `invalid-output` at `output-validation`; the VP9 source then reached `interactiveReady`, Rabbit pixels were visible, and the touch checkpoints succeeded. |
| Galaxy S24 / Android 14 / Chrome, HTTPS | Every authored codec attempt ended in `worker-decode-failure`; diagnostics retained source 0 `invalid-output`. This is a separate packed-frame geometry issue, and the attempted H.264 source did not make the session pass. |
| Windows 11 / Chrome 150, 149, and 148, HTTPS | Each session ended in `renderer-failure`. |
| Windows 11 / Chrome 127, HTTPS | AV1 reached `interactiveReady`, Rabbit pixels were visible, and the interaction checkpoint count increased. |

These checks establish outcomes only for the listed profiles. They do not
certify untested Safari/iOS versions, Android devices or Chrome versions, other
desktop browsers, or a complete rolling compatibility matrix.

The earlier H.264 Safari success in the 2026-07-18 table belonged to the
single-codec Kinetic Orb. It did not prove that the four-source Rabbit could
advance past a positively probed AV1 candidate.

A separate physical-phone request to `http://192.168.86.25:5173` was not a
codec test. Safari reported `isSecureContext === false`, and `crypto.subtle`
was unavailable. No codec conclusion can be drawn from that LAN HTTP result;
it does not contradict the HTTPS BrowserStack checks.

Exact dotted Safari/WebKit and Android Chrome builds were not captured for
these focused sessions. The Windows observations retain the reported Chrome
majors, not full build/channel identities. This follow-up is therefore targeted
regression evidence rather than completed rolling-matrix certification.

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

## Follow-up priorities derived from the audit

1. Keep the implemented startup source qualification/failover covered as a
   release regression: retire a candidate that fails codec qualification, try
   the next authored rendition in the same source generation, and publish a
   fatal error only after all authored candidates are exhausted. This is source
   failover, not UI fallback.
2. Fix Android packed-frame geometry handling. Preserve output validation and
   either normalize platform `VideoFrame` geometry/metadata or adapt the
   packed-alpha validator to the proven Android representation.
3. Reproduce the Windows renderer `prepare` failure outside BrowserStack's GPU
   environment, then isolate WebGL2, transferable canvas/context, and GPU
   blocklist behavior before classifying it as a Chrome product regression.
4. Keep the exact version/build/channel matrix and fatal-error-boundary witness
   in release certification so unsupported or inconclusive slots cannot be
   summarized as passing.
