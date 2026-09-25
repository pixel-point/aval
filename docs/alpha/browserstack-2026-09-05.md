# Aval Alpha BrowserStack qualification — 2026-09-05

The subsequent [fixes and affected-device retest](./browserstack-fixes-2026-09-05.md)
records the corrected runtime and new results. This document preserves the
original build's findings.

Status: testing complete; qualification is not a clean pass. Transparent playback
was observed on all 12 combinations with at least one codec. The baseline harness
recorded 173 passes, five codec skips and two failures. Focused diagnosis confirmed
an iOS 15 pending-command defect and a Windows Chromium startup context-loss
defect. No runtime fixes were applied during this test run.

## Artifact and method

The existing `examples/alpha` demo is built with Vite 8.1.4 and served as an
isolated static production build over a temporary Cloudflare HTTPS tunnel.
BrowserStack Live sessions are operated through the in-app browser. Mobile
targets use BrowserStack's real-device pool; desktop targets use its remote
desktop browsers. These results do not refer to local Playwright emulation.

Workspace base: `10d0bd3b975a2a190de694d0d9f944cdeb245ec6`, with existing
uncommitted Alpha implementation changes. Core/element source aliases in the
demo are compiled into the production asset. This is not an npm tarball test.

Initial bundle: `index-CGJ2qr7f.js`, SHA-256
`e0bdf385bcb840d152c5e3edc67800f34ea0b85914005070d43fd9725c5863a4`.

The fixtures are 128×96, two seconds, 12 fps, with color and alpha packed into
128×200 video. AV1, VP9, HEVC and H.264 are supplied in that order. This small
calibration clip establishes correctness, not production-resolution performance.

## Executed matrix

Device/OS labels come from BrowserStack; browser versions come from its session
selection and the displayed harness user agent. These are the versions actually
tested, not a claim about the newest generally available browser releases.

| Target | Browser | Purpose | Result |
| --- | --- | --- | --- |
| iPhone 17, iOS 26.5 | Safari 26.5 | Recent Apple phone and codec coverage | 15/15 passed; all four codecs |
| iPhone 16, iOS 18.6 | Safari 18.6 | Previous major iOS family | 15/15 passed; all four codecs |
| iPhone 13, iOS 15.6 | Safari 15.6 | Older Apple hardware and API fallback | 12 passed, 2 codec skips, 1 pending-command failure |
| iPad Pro 11 (2025), iPadOS 26 | Safari 26.6.1 | Tablet dimensions and rotation | 15/15 passed; all four codecs |
| Pixel 10, Android 16 | Chrome 149 | Google Android implementation | 15/15 passed; all four codecs |
| Galaxy S25, Android 15 | Chrome 149 | Samsung hardware and decoder path | 15/15 passed; all four codecs |
| Galaxy S25, Android 15 | Samsung Internet 30 / Chromium 143 | Alternative Android browser | 15/15 passed; all four codecs |
| Windows 11 | Chrome 152 | Windows Chromium implementation | 14 passed, HEVC skipped; startup context loss; reload recovered |
| Windows 11 | Edge 152 | Windows Edge decoder availability | 14 passed, HEVC skipped; startup failed; reload recovered |
| Windows 11 | Firefox 154 | Windows Gecko implementation | 14 passed; HEVC decoding failed |
| macOS Tahoe | Safari 26.4 | Shipping desktop WebKit | 15/15 passed; all four codecs |
| macOS Sonoma | Safari 17.3 | Older desktop WebKit | 14 passed; AV1 skipped |

## Acceptance and evidence

- Confirm the demo loads, its selected source is identified, and transparent
  bands visibly composite over checkerboard, black, white and magenta.
- Run the existing 15-check harness. Record each codec as passed, failed or
  not advertised. A skipped codec is not evidence that decoding works.
- Pixel assertions require alpha `[0, 64, 128, 255]` within four levels and
  premultiplied color within seven levels, plus an advancing playback clock.
- Check failed-source fallback, wrong-dimension fallback, terminal failure,
  cleanup, WebGL failure, looping, pause/resume, context restoration, autoplay
  rejection, source replacement, reconnection and pending-operation disposal.
- Manually inspect playback controls, mobile rotation and background/foreground
  return where the BrowserStack session supports them.
- Capture actual results and screenshots. Report harness/platform limitations
  separately from runtime defects. Retry only to investigate a concrete failure.

The additional four cross-origin network cases require the existing test
server's `network-checks` parameter and are outside the ordinary demo button.
They are not included in the 15-check device claim.

## Setup

BrowserStack Local could not be installed by the user. At their request,
Cloudflare Tunnel was used instead. `cloudflared` 2026.8.2 was installed using
Homebrew. The temporary HTTPS endpoint returned HTTP 200 for the demo and HTTP
206 for a media byte-range request. Only the generated demo directory is served.

## Results

### iPhone 17 / iOS 26.5 / Safari 26.5

All 15 checks passed. Each codec recovered exactly `[0, 64, 128, 255]` alpha.
Landscape rotation preserved rendering. After opening the iOS home screen and
returning to Safari, transparent animation remained visible and its moving
marker changed position. Evidence: `.cache/alpha/browserstack-2026-09-05/iphone17-ios26.5-safari.json`,
`iphone17-landscape.png`, and `iphone17-foreground.png`.

BrowserStack labels the OS 26.5. The recorded Safari user agent reports
`CPU iPhone OS 18_7` and `Version/26.5`; both labels are retained rather than
inferring the OS solely from the user agent.

### iPhone 16 / iOS 18.6 / Safari 18.6

All 15 checks passed, including all four codecs and exact alpha calibration
bands. Evidence: `iphone16-ios18-safari.json` and `iphone16-results.png` in
the evidence directory.

### iPhone 13 / iOS 15.6 / Safari 15.6

The page automatically selected HEVC. HEVC and H.264 recovered exact alpha bands;
AV1 and VP9 were not advertised and were skipped. `VideoDecoder` is absent on
this device. Twelve checks passed, including normal playback, fallback, looping,
seeking, context restoration and cleanup. The pending element command/source
replacement check failed with `A pending seek targeted the replacement player`.
The same failure repeated in a second run (`iphone13-ios15-safari-repeat.json`).
Focused diagnosis below confirmed the seek actually reached the replacement
video. Evidence: `iphone13-ios15-safari.json`.

### iPad Pro 11 (2025) / iPadOS 26 / Safari 26.6.1

All 15 checks passed, read directly from the device screen. All four codecs
recovered exact alpha bands. The Safari user agent identifies a desktop Mac
(as used by iPad desktop browsing), with `Version/26.6.1`. BrowserStack identifies
the physical device as iPad Pro 11 2025 and the OS as 26. Both inspector choices
attached to a Safari extension background page, so no JSON export is claimed.
Landscape rotation also preserved transparent rendering (`ipad-landscape.png`).
The full report is covered by `ipad-report-1.png` (11 lifecycle checks),
`ipad-report-2.png` (user agent, AV1 and VP9), and `ipad-report-3.png` (HEVC and H.264).

### Galaxy S25 / Android 15 / Chrome 149

All 15 checks passed, including all four codecs with exact alpha bands. The
reduced Chrome user agent says Android 10; BrowserStack identifies Android 15.
Evidence: `galaxy-s25-android15-chrome149.json`.

### Galaxy S25 / Android 15 / Samsung Internet 30

All 15 checks passed. All four codecs recovered exact alpha bands. BrowserStack
disables the DevTools control for this browser; the report was read directly
from the phone screen. Evidence: `samsung-internet-report-1.png` through
`samsung-internet-report-7.png`. The user agent identifies SamsungBrowser/30.0
and Chrome/143.0.0.0.

### Temporary report presentation

After the Samsung Internet run, the served HTML gained a compact summary of
the existing JSON results and smaller demo dimensions. A MutationObserver reads
`#results` and displays pass/fail/skip counts, user agent, codec pixel values
and the existing assertion messages. The original runtime/harness JS asset and
assertions are unchanged. This is temporary test presentation in the isolated
build directory, not a runtime source change.

### Pixel 10 / Android 16 / Chrome 149

All 15 checks passed. All four codecs recovered exact alpha bands. The complete
compact report is visible in `pixel10-summary-1.png`. The BrowserStack DevTools
control became disabled, so no JSON export is claimed.

### Windows 11 / Chrome 152

The first page load reported `No source could start transparent playback`.
The subsequently invoked harness passed 14 checks; only HEVC was not advertised
and skipped. AV1, VP9 and H.264 recovered exact alpha bands. Reloading the page
started AV1 playback normally. Further sessions confirmed the initial failure
occurs with a lost WebGL context, as detailed below. After reload, transparent
bands also visibly composited over black, white and magenta backgrounds
(`windows11-chrome152-black.png`, `windows11-chrome152-white.png`, and
`windows11-chrome152-magenta.png`).
Evidence: `windows11-chrome152-first-start.png`, `windows11-chrome152-summary.png`,
and `windows11-chrome152-reload.png`.

### Windows 11 / Edge 152

The initial session load showed the same startup error as Chrome. The harness
passed 14 checks, with HEVC not advertised and skipped. AV1, VP9 and H.264
recovered exact alpha bands. Reloading restored normal AV1 playback. Evidence:
`windows11-edge152-first-start.png`, `windows11-edge152-summary.png`, and
`windows11-edge152-reload.png`.

### Windows 11 / Firefox 154

Initial AV1 playback worked. The completed summary reported 14 passes, one
failure, zero skips. AV1, VP9 and H.264 decoded with exact alpha bands. HEVC
was advertised but failed to start (`No source could start transparent playback`).
The completed counts imply all 11 lifecycle checks passed; their individual
rows were not all captured before BrowserStack disconnected with a network
error. Evidence: `windows11-firefox154-summary.png` and
`windows11-firefox154-session-network-error.png`. The session transport failure
is recorded separately from the HEVC decoding result.

### macOS Tahoe / Safari 26.4

Initial playback and all 15 checks passed, including all four codecs and exact
alpha bands. Evidence: `macos-tahoe-safari26.4-summary.png`. The red BrowserStack
network banner in this capture persisted from the previous Firefox session;
the Safari session was active and completed its report.

### macOS Sonoma / Safari 17.3

Initial playback selected VP9. Fourteen checks passed; AV1 was not advertised
and skipped. VP9, HEVC and H.264 recovered exact alpha bands. All 11 lifecycle
checks passed. Evidence: `macos-sonoma-safari17.3-summary.png`.

## Baseline totals

The 12 baseline runs comprise 180 checks: 173 passed, five codec skips and two
failures (iOS 15 pending-operation assertion and Windows Firefox HEVC decode).
Repeated diagnostics are excluded from these totals. Initial Chromium/Edge
startup errors are additional observations outside the 15-check report.

## Focused diagnosis

### Confirmed iOS 15 runtime defect

A separate diagnostic copy retains the player code and assertions, but includes
the pending promise outcome and replacement video time in the failure message.
On a further real iPhone 13 / iOS 15.6 session it reported:

`Pending seek outcome=resolved; replacement currentTime=0.5`

This confirms that a queued seek can cross source replacement and control the
new video. It is not merely a mismatched error code. The baseline assertion
failed on both earlier runs as well. The relevant path is `AvalAlphaElement.seek`
and `#readyPlayer` in `packages/alpha/src/element.ts`: readiness crosses async
boundaries before choosing/validating which player the operation owns.
The precise Safari scheduling difference has not been established.

Evidence: `iphone13-ios15-diagnostic.json`, `diagnostic.js`, `diagnostic.html`,
and `original-runtime-and-harness.js`. No runtime fix was applied during qualification.

### Confirmed Windows Chrome startup context-loss defect

Fresh Windows 11 / Chrome 152 sessions reproduced the initial startup failure.
A temporary HTML error reporter exposed each source attempt's existing error
details. AV1, VP9 and H.264 were rejected with `Packed video exceeds the texture
limit`; HEVC was separately rejected as an unsupported type. The packed fixture
is only 128×200 pixels.

A further diagnostic bundle changed only that error's message to include the
queried limit, context-loss flag and document visibility. It recorded, for all
three advertised codecs:

`Packed video exceeds the texture limit; max=null; contextLost=true; visibility=visible`

The compositor compares source dimensions with `gl.getParameter(MAX_TEXTURE_SIZE)`
without checking context loss. A null result is coerced to zero in the comparison.
The player then treats this shared rendering failure as a failed source, exhausts
the candidates and disposes the player. It does not wait for restoration during
startup. This explains the recorded failure path; the cause of the browser's
initial context loss is not established. BrowserStack's remote desktop startup
may trigger it, and this is not evidence that every Windows page load fails.

Reloading restored normal playback on both Chrome and Edge. The separate harness
context-restoration check passed after startup; it does not cover this startup
race. Edge had the same visible startup/reload behavior, but its context flags
were not separately instrumented, so the exact shared cause remains an inference.

Relevant code: `configure` in `packages/alpha/src/compositor.ts` and the candidate
startup loop in `packages/alpha/src/player.ts`. Evidence:
`windows11-chrome152-startup-diagnostic.png`,
`windows11-chrome152-context-diagnostic.png`, and `diagnostic-context.js`.

## Codec findings and qualification limits

Every successful codec pixel check recovered alpha `[0, 64, 128, 255]` exactly
and passed the premultiplied RGB and advancing-clock assertions. H.264 passed
on all 12 combinations. AV1 and VP9 were not advertised on iOS 15; AV1 was also
not advertised on Safari 17.3. HEVC was not advertised in Windows Chrome/Edge
and failed decoding in Windows Firefox despite being advertised. A source list
with working alternatives is necessary; one codec alone does not cover this matrix.

Manual rotation was exercised on iPhone 17 and iPad Pro, home-screen return on
iPhone 17, and all four display backgrounds on Windows Chrome. Those manual
checks were not repeated on every target. The harness exercised playback,
seeking, pause/resume, looping and the listed lifecycle checks on all targets.

These runs cover the core player and custom element using a small 8-bit synthetic
fixture. They do not qualify React/Svelte adapters, installed npm tarballs,
10-bit playback, power-saving modes, long sessions, production-resolution clips,
memory/energy use or startup transfer under constrained networks. The four
additional cross-origin network cases were not executed in this device matrix.

Before a broad reliability claim, fix the pending-command and startup context-loss
paths and rerun the affected devices plus regression coverage. Separately qualify
representative production content and the intended codec fallback policy.

## Saved evidence

Screenshots, the exported JSON reports where the remote inspector allowed them,
the two diagnostic bundle variants, the original runtime/harness bundle, a copy
of the served demo and a machine-readable matrix are saved under
`.cache/alpha/browserstack-2026-09-05/`. `SHA256SUMS` identifies their exact bytes.
The portable evidence archive is `.cache/alpha/browserstack-2026-09-05.zip`.
The temporary BrowserStack session, tunnel and isolated preview server were
stopped after testing. The installed `cloudflared` CLI remains available.
