# aval-alpha verification

Local preview evidence, 2026-09-04. Host: macOS 15.6, arm64. This records the
checks performed for the implementation; it is not a device certification.

The [npm release verification, 2026-09-05](./npm-release-2026-09-05.md) records
the published package versions and subsequent isolated registry-install,
compiler, production playback and framework hydration checks.

The subsequent [BrowserStack device matrix, 2026-09-05](./browserstack-2026-09-05.md)
records 12 real-mobile/remote-desktop combinations, codec results and two runtime
defects found during qualification. The local results below remain a historical
record of the earlier run.

The [fixes and affected-device retest](./browserstack-fixes-2026-09-05.md) records
the subsequent runtime corrections and expanded regression coverage.

## Visitor delivery

Measured from the built package by `npm run alpha:size`, using the pinned Vite
8.1.4 production minifier, ES2022 target, gzip level 9 and Node Brotli defaults.
Core, element and shared binding entries produce one standalone ES module with
no external imports. Framework entries include the player, shared binding and
adapter, with the application's React or Svelte peer externalized. Their peer
imports are additional if that framework is not already supplied by the app.

| Entry | Minified bytes | gzip bytes | Brotli bytes |
| --- | ---: | ---: | ---: |
| Core player | 9,114 | 3,606 | 3,150 |
| Player plus `<aval-alpha>` | 12,176 | 4,600 | 4,028 |
| Element increment | 3,062 | 994 | 878 |
| Player plus shared binding | 12,351 | 4,572 | 4,040 |
| React package, including player and binding | 13,364 | 4,952 | 4,360 |
| Svelte package, including player and binding | 14,020 | 5,139 | 4,517 |
| React increment over core | 4,250 | 1,346 | 1,210 |
| Svelte increment over core | 4,906 | 1,533 | 1,367 |

All proposed size gates pass. There is no decoder binary, worker, shader file,
JavaScript demuxer or AVAL runtime dependency to fetch. A selected media file is
additional. Layout metadata can be inlined; a metadata fetch is optional. Transfer
sizes assume the hosting server enables the corresponding HTTP compression.
The npm tarball includes declarations and documentation; its size is not the
visitor's runtime download size.

The measurement rejects imports outside the measured alpha packages, external
imports other than the declared framework peer, dynamic imports and
non-JavaScript runtime resources. Framework increments are capped at 2,000 gzip
and 1,800 Brotli bytes; the original core and element limits are unchanged.
Reproduce with
`scripts/alpha/measure-bundles.mjs`; output is `.cache/alpha/bundles/sizes.json`.

The existing interactive runtime's separate production measurement failed its
60,000-byte Brotli cap at 106,684 bytes in this checkout. That is a separate
measurement configuration and product; it is not used as a like-for-like
percentage comparison or changed by this work.

## Decoding and browser checks

The automated suite runs with the native APIs, then repeats with `VideoDecoder`
and `requestVideoFrameCallback`/`cancelVideoFrameCallback` removed. All six runs
passed. This exercises the rAF path; it does not emulate every feature of an old
browser version.

| Local browser build | AV1 | VP9 | HEVC | H.264 |
| --- | --- | --- | --- | --- |
| In-app Chromium 152 | Pass | Pass | Pass | Pass |
| Playwright Chromium 149.0.7827.55 | Pass | Pass | Not advertised, skipped | Pass |
| Playwright Firefox 151 | Pass | Pass | Pass | Pass |
| Playwright WebKit, Safari 26.5 user agent | Pass | Pass | Pass | Pass |
| Shipping Safari, real iOS, Android, Windows | Untested | Untested | Untested | Untested |

Every tested 8-bit codec recovered the calibration bands `[0, 64, 128, 255]`
from the input, including fully transparent and fully opaque coverage. The
50%-alpha colored sample matched expected premultiplied RGB within one level
in the visible desktop check. Assertions allow a small codec-dependent error;
these values do not imply lossless alpha for arbitrary CRF or content.

The browser harness also verifies failed-first-source fallback, a never-fetched
later candidate, dimension mismatch fallback, all-candidate failure, disposal
while loading, unavailable WebGL, pause/resume/seek/loop, context loss and
restoration during playback, autoplay rejection, source replacement, attribute
updates, disconnect/reconnect, CORS-enabled media, denied CORS, startup timeout,
and truncated responses. CORS and network cases use a real second local HTTP
origin. Browser request lists and per-codec results are attached to
`.cache/alpha/browser-report.json`.

WebKit automation is not shipping Safari certification. HEVC eligibility on this
Mac does not establish HEVC support on another operating system or device.
Native decoder availability remains a reason to publish multiple sources.

## Framework adapters

React 19.2.7 and Svelte 5.56.8 each passed the complete adapter flow in Chromium,
Firefox and WebKit (six browser tests). Tests consume the built packages through
their public exports and hydrate actual server-rendered markup. They verify the
canvas survives hydration, React Strict Mode releases its replayed mount,
equivalent source arrays/callback changes preserve the native video, source
replacement releases it, loop/play/pause/seek remain reactive, and transparent
pixels retain the calibration bands. Unmount/remount, removed CSS dimensions,
terminal errors, current callbacks and Svelte controller replacement through
`$state` proxies also pass. Unused fallback media is never requested.

The shared binding's unit tests cover detached commands, source/layout/CORS/
timeout replacement, pending-load cancellation, current callbacks, autoplay
policy rejection, stale completion rejection, exclusive canvas ownership and
subscriber-driven replacement. React and Svelte SSR tests verify inert markup
without DOM globals. `npm run test:alpha` passes 57 tests; six compiler media
tests require the separate opt-in FFmpeg command and are skipped in this run.
`npm run typecheck:alpha` includes both packages, their public consumer contracts
and the framework demos. The architecture gate checks that wrappers import only
their framework and the public alpha API, and that the core has no runtime
dependencies. The framework flow also has a dedicated CI job.

React 18.3 is supported by the API/peer declaration; browser execution in this
checkout used React 19.2.7. Svelte execution used 5.56.8. Earlier framework
versions and physical mobile devices were not tested in this adapter run.

## Compiler and quality

FFmpeg/FFprobe 8.1.2 produced software SVT-AV1, libvpx-vp9, libx265 and libx264
outputs. The compiler integration tests cover all four codecs, odd dimensions,
10-bit AV1/HEVC, horizontal portrait packing, CRF/preset search, output collision,
failed-build cleanup, cancellation, existing VP9 WebM alpha input, and explicit
premultiplied input. Node and browser declarations pass type checking; the
compiler alpha API report is generated in `etc/api/compiler-alpha.api.md`.

The two-second synthetic fixture is 128×96 at 12 fps, packed into 128×200.
It contains alpha endpoints, partial coverage, a gradient and moving color.
These sizes describe this calibration fixture only:

| Codec, CRF 16 | Media bytes | Alpha MAE | Composite MAE |
| --- | ---: | ---: | ---: |
| SVT-AV1 | 2,288 | 0.074 | 0.430 |
| VP9 | 1,535 | 0.082 | 0.424 |
| x265 HEVC | 4,715 | 0.077 | 0.422 |
| x264 H.264 | 2,891 | 0.126 | 0.436 |

MAE uses the 0–255 scale over all frames. Composite MAE averages black, white,
and magenta backgrounds. Equal CRF across codecs is not equal quality. These
figures justify using measured source order rather than assuming AV1 is always
smallest. The offline search records the size/quality frontier for each actual
input instead of selecting a universal preset.

The stricter checks caught two implementation errors before completion: an
unwanted FFmpeg color-matrix conversion on untagged raw YUV, and unreliable
filter negotiation for premultiplied input. The compiler now tags its prepared
YUV before encoding and normalizes premultiplied RGBA channels explicitly. The
reference files used for quality scoring contain the normalized straight colors.

## Packaging and existing regressions

`npm run alpha:pack` packs the runtime and both framework adapters, installs them
into isolated temporary consumers, checks public imports and TypeScript
declarations, and verifies the dependency boundaries. It checks core/adapter
SSR imports, React and Svelte server rendering, and a production browser bundle
of both framework consumers. Peer dependency closures are packed from the exact
installed versions, so the checks need no registry access. The runtime, framework
and compiler tarballs are in `.cache/alpha`; nothing was published.
`aval-alpha` has its own 0.1.0 preview version and is not silently added to the
existing synchronized six-package publication transaction.

All alpha-specific checks pass. The existing compiler suite passed 288 tests,
with nine skipped and one failing because the installed FFmpeg lacks libaom-AV1.
The alpha compiler defaults to the available SVT-AV1 encoder; its optional
libaom adapter is implemented but has not been executed on this host. Existing
release tests also contain 1.0.0 fixture expectations against the 1.0.1 workspace
and pending publication identity metadata. The existing docs gate similarly
expects 1.0.0 dependencies in examples now using 1.0.1. The new compiler subpath was added
to both existing export-contract authorities; the manifest checks pass.

## Remaining qualification

Before claiming broad device support, test shipping Safari/iOS, Android Chrome,
Windows Chrome/Edge, and Firefox on the intended devices, including background
transitions, power-saving modes and hardware decoder surface limits. Browser
engines on one Mac cannot prove those combinations.

Large and representative production clips still need measurements of bytes
actually received before first draw, dropped frames, per-upload time and decoder
memory under realistic networking. The current harness records local startup
time and requested URLs, not a complete startup-transfer or memory benchmark.
The eight-pixel gutter is a conservative reused preparation rule; alternative
gutter widths and encoder ROI have not been benchmarked. A libaom-versus-SVT
comparison and real-device 10-bit playback qualification also remain open.

These are explicit limits of the preview's evidence. The implemented runtime,
compiler, search, package artifacts and local regression gates are usable now.

The follow-up [code quality audit](./code-quality-review.md) records lifecycle
regressions fixed after the initial implementation and the compiler simplifications.

The [release readiness audit](./release-readiness.md) compares this preview with
the existing publication process and lists the remaining automation, artifact,
API, documentation and qualification work.
