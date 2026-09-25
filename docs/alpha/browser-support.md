# Aval Alpha tested compatibility

Tested on **2026-09-05** using the core player and `<aval-alpha>` demo. Mobile
sessions used BrowserStack's real devices; desktop sessions used its remote
Windows and macOS browsers. Transparent playback succeeded with at least one
codec on every configuration below. H.264 passed on every listed configuration.

## Device and browser matrix

**Pass** means the calibration clip decoded, recovered the expected transparent
pixels and premultiplied color, and advanced its playback clock.
**Not advertised** means the browser did not advertise that codec and the test
was skipped. **Native failure** means decoding also failed in an ordinary video
element without Aval.

| Device / OS | Browser | AV1 | VP9 | HEVC | H.264 | Build tested |
| --- | --- | --- | --- | --- | --- | --- |
| iPhone 17 / iOS 26.5 | Safari 26.5 | Pass | Pass | Pass | Pass | Initial |
| iPhone 16 / iOS 18.6 | Safari 18.6 | Pass | Pass | Pass | Pass | Initial |
| iPhone 13 / iOS 15.6 | Safari 15.6 | Not advertised | Not advertised | Pass | Pass | Fixed |
| iPhone 13 / iOS 15.5 | Safari 15.5 | Not advertised | Not advertised | Pass | Pass | Fixed |
| iPad Pro 11 (2025) / iPadOS 26 | Safari 26.6.1 | Pass | Pass | Pass | Pass | Initial |
| Pixel 10 / Android 16 | Chrome 149 | Pass | Pass | Pass | Pass | Initial |
| Galaxy S25 / Android 15 | Chrome 149 | Pass | Pass | Pass | Pass | Initial |
| Galaxy S25 / Android 15 | Samsung Internet 30 / Chromium 143 | Pass | Pass | Pass | Pass | Initial |
| Windows 11 | Chrome 152 | Pass | Pass | Not advertised | Pass | Fixed |
| Windows 11 | Edge 152 | Pass | Pass | Not advertised | Pass | Fixed |
| Windows 11 | Firefox 154 | Pass | Pass | Native failure | Pass | Fixed |
| macOS Tahoe | Safari 26.4 | Pass | Pass | Pass | Pass | Initial |
| macOS Sonoma | Safari 17.3 | Not advertised | Pass | Pass | Pass | Initial |

Device/OS labels come from BrowserStack; browser versions come from the session
selection and recorded user agent. These are observed versions, not minimum
supported versions or a promise about every browser in the same family.

## Build and lifecycle qualification

**Initial** refers to the [original qualification run](./browserstack-2026-09-05.md).
Those eight configurations passed every applicable check in the 15-check harness.
They have not been rerun on the fixed build.

**Fixed** refers to the [affected-device retest](./browserstack-fixes-2026-09-05.md)
after correcting pending commands during source replacement and WebGL context
loss during startup. All 16 lifecycle checks passed on these five configurations.
Windows Chrome and Edge started successfully without a reload. On the same
iPhone 13 running iOS 15.6, the old build reproduced the pending-seek failure
and the fixed build passed. The remaining Firefox HEVC failure is a native
media limitation for the tested file in that environment; the other three
codecs rendered transparent pixels successfully.

Both reports record the exact bundle hashes, check counts, screenshots and
diagnostic evidence. A codec pass in this table is distinct from the lifecycle
qualification of a particular build.

## Scope

The fixture is an 8-bit, two-second, 12 fps calibration clip with a 128×96 visible
image packed into 128×200 video. Successful codec checks recovered alpha
`[0, 64, 128, 255]` exactly. These results do not qualify arbitrary resolutions,
codec profiles, 10-bit content, long sessions, memory/energy use or power-saving
modes. Native video decoding and WebGL1 are required; WebCodecs is not required.

The device matrix covers the core player and custom element compiled from
workspace source. React/Svelte adapters and installed package artifacts have
separate local checks, documented in the [retest report](./browserstack-fixes-2026-09-05.md)
and [verification record](./verification.md). They were not exercised on the
physical devices in this matrix.
