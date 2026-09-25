# Aval Alpha fixes and device retest — 2026-09-05

Follow-up to [the original 12-target matrix](./browserstack-2026-09-05.md).
Status: complete. Both runtime defects are fixed and verified on the affected
platforms. Firefox's remaining HEVC-file failure also occurs without Aval.

## Changes

Element commands consume pending DOM source edits and capture their player before
awaiting readiness. Source replacement therefore cannot redirect an older pending
command. The load boundary refuses detached elements.

Startup detects WebGL context loss even before the loss event is delivered. It
waits for restoration, then configures and draws the same candidate. Waiting is
bounded by the configured timeout and cancelled on disposal. A lost context no
longer gets interpreted as a zero texture limit or an unsupported codec.

Five new browser assertions cover context loss before construction and during
loading, timeout, disposal, and immediate commands after DOM source edits. The
existing pending-command assertion is retained. No codec result was converted
from failure to skip to make the matrix pass.

## Fixed-build device results

The production demo uses the same four 128×200 packed calibration clips and a
new 20-check harness. The bundle is `index-CjSonWW8.js`, SHA-256
`238f13916e249bec762084423dc1cce416732bb5cfc127ac3233bf521a55420c`.
Cloudflared serves only this isolated static build. Compact report presentation
is appended to the served HTML; the tested runtime and assertions are unmodified.

| BrowserStack target | Passed | Failed | Skipped | Observation |
| --- | ---: | ---: | ---: | --- |
| Windows 11 / Chrome 152 | 19 | 0 | 1 | Fresh startup worked without reload; HEVC not advertised |
| Windows 11 / Edge 152 | 19 | 0 | 1 | Fresh startup worked without reload; HEVC not advertised |
| iPhone 13 / iOS 15 / Safari 15.5 | 18 | 0 | 2 | Pending command and all context checks passed; AV1/VP9 not advertised |
| iPhone 13 / iOS 15.6 / Safari 15.6 | 18 | 0 | 2 | Exact affected version; old build failed and fixed build passed on the same phone |
| Windows 11 / Firefox 154 | 19 | 1 | 0 | HEVC decode failed; all lifecycle checks and other codecs passed |

Total: 93 passes, six skips and one HEVC failure across 100 checks. Every
successful codec recovered exact alpha `[0, 64, 128, 255]` and passed the RGB
and playback-clock assertions. These totals include the fixed half of the paired
iOS comparison, and exclude the old-build and plain-video controls below.

BrowserStack's first iPhone 13 / iOS 15 selection returned Safari/iOS 15.5.
A subsequent session supplied 15.6, matching the original affected version.
Both are recorded separately.

## Local regression coverage

- The new checks failed against the previous runtime in both Chromium modes,
  reproducing premature startup failure and incorrect disposal behavior.
- All six final local browser runs passed: Chromium, Firefox and WebKit, each
  with native APIs and again without WebCodecs/video-frame callbacks. Each run
  includes the 20 ordinary checks plus four cross-origin network checks.
- All six React/Svelte browser tests passed, covering hydration, playback,
  reactive configuration and cleanup.
- Unit suite: 57 passed, six optional FFmpeg tests skipped.
- Type checks, architecture checks, isolated package install/SSR/production
  bundle checks and byte-size gates passed. Core: 3,826 gzip bytes; element
  increment: 999 gzip bytes. The original size budgets were retained.

## Focused controls

### Firefox HEVC without Aval

A separate page loads the exact same HEVC and H.264 files in ordinary native
video elements, without Aval or WebGL. Firefox advertises both as `probably`.
HEVC fails before metadata becomes available, with `MediaError.code = 4` and
`NS_ERROR_DOM_MEDIA_METADATA_ERR (0x806e0006)`; decoded dimensions remain zero.
H.264 reaches `loadeddata`, reports the expected 128×200 dimensions, and has no
media error. Evidence: `windows11-firefox154-native-codecs.png` and the saved
`served-demo/native.html` control.

This isolates the remaining calibration-file HEVC failure to native media
handling in this Windows Firefox environment. It does not establish that every
HEVC file fails everywhere. The existing alternative-source policy is retained;
AV1, VP9 and H.264 all passed Aval's transparent pixel checks here.

### Same-device iOS comparison

A further BrowserStack iPhone 13 session identified iOS/Safari 15.6. Its
`before.html` page uses the exact archived original runtime/harness bundle,
SHA-256 `e0bdf385bcb840d152c5e3edc67800f34ea0b85914005070d43fd9725c5863a4`.
It reproduced the original pending-command failure: 12 passes, one failure,
two codec skips. The page's link then opened the fixed build on that same phone,
without ending the session. The fixed build passed the pending-command assertion
and all five new regression checks: 18 passes, zero failures, two codec skips.

Evidence: `iphone13-control-before-1.png` and `iphone13-control-before-2.png`
capture the failure and OS version; `iphone13-ios15.6-fixed-summary-1.png` and
`iphone13-ios15.6-fixed-summary-2.png` capture the corrected assertions and totals.

## Scope and evidence

No public API, runtime dependency or codec fallback policy changed. Physical
mobile testing uses BrowserStack's real-device pool; Windows browsers run in its
remote desktop environment. The eight unaffected combinations from the earlier
matrix were not rerun with this build. Large clips, 10-bit playback, long-running
memory/energy behavior and power-saving modes remain outside this qualification.

Evidence lives in `.cache/alpha/browserstack-fixes-2026-09-05/`; the portable
archive is `.cache/alpha/browserstack-fixes-2026-09-05.zip`. It includes screenshots,
local machine-readable reports, a transcribed device matrix, source hashes and
the served demo/control pages. `SHA256SUMS` records the archived file bytes.
Device results were read from the visible report; no remote JSON export is claimed
for this retest. The tunnel, isolated preview server and BrowserStack session were
stopped after testing.
