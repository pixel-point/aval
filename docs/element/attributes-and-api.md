# Attributes and API

The reflected host attributes are exactly `crossorigin`, `motion`, `autoplay`,
`fit`, `bindings`, `state`, `interaction-for`, `width`, and `height`. Source
URLs and integrity belong only to direct-child `<source>` elements.

| Attribute | Values | Default |
|---|---|---|
| `crossorigin` | `anonymous`, `use-credentials` | `anonymous` |
| `motion` | `auto`, `reduce`, `full` | `auto` |
| `autoplay` | `visible`, `manual` | `visible` |
| `fit` | `contain`, `cover`, `fill`, `none` | asset fit |
| `bindings` | `auto`, `none` | `auto` |

Each direct child requires nonempty `src` and `data-codec` set to exactly
`av1`, `vp9`, `h265`, or `h264`; its `integrity` is optional. Each family may
appear once, and the declared family must match the codec family in that
source's `.avl` manifest; a mismatch is an invalid asset. `crossorigin` is
shared by the host. Child order has no priority meaning: AVAL evaluates AV1,
VP9, H.265, then H.264. A
positive `VideoDecoder.isConfigSupported()` result is provisional: an animated
candidate wins only after the production path decodes, transfers, validates,
and presents its initial frame. Same-task source mutations coalesce. A new
source snapshot first completely disposes the old generation; only the newest
pending snapshot may start. Policy, fit, input, state, and size changes do not
replace the asset.
Code that needs to present or validate the same family order can import the
frozen `SOURCE_CODEC_PRIORITY` tuple from `@pixel-point/aval-element` rather
than repeating the policy.

An unsupported configuration advances to the next authored rendition or codec
family. Before `interactiveReady`, a decoder startup failure advances only
when bounded diagnostics identify codec qualification evidence such as
unsupported configuration, invalid output, or `EncodingError`/
`NotSupportedError` during configure, decode, flush, or output validation, or a
decoder-local codec support-probe, decode, or flush progress timeout. Network,
CORS/CSP, integrity, malformed-asset, resource, worker transport,
renderer/context, cleanup, abort, and non-decoder watchdog failures are terminal
for that generation. Once a candidate reaches `interactiveReady`, every later
fatal failure—including a decoder progress timeout—is terminal and the active
codec never hot-switches.

Properties validate synchronously and never mutate on invalid input. Invalid
HTML attribute text falls back to the documented default and emits a nonfatal,
normalized `error` event. Source strings are capped at 4,096 UTF-16 code
units, interaction IDs at 256, state names use the format identifier grammar,
and size hints are positive safe integers. They are not silently clamped;
actual canvas, browser, and device limits can instead produce an explicit
capability/resource failure. The element has no external
image URL API. On the supported path, the first visible internal pixels are a
decoded motion frame. AVAL has no fallback slot and never reveals, hides, or
selects alternate application DOM. A consumer that wants an image or other
fallback keeps it beside the element and responds to `AvalPlaybackError` or the
fatal `error` event.

Core methods are `prepare`, `setState`, `send`, `readyFor`, `pause`, `resume`,
`getDiagnostics`, and `dispose`. Caller abort signals and `timeoutMs` bound only
that caller's `prepare()` wait; they do not cancel connected shared preparation.
`setState()` returns the graph-authored settlement promise. `send()` is
synchronous. `state` remains declarative intent and is not rewritten by
imperative requests.

Read-only staged properties include readiness, mode, static policy reason,
requested/visual state, transition state, pause intent, effective visibility,
and immutable discovered state/event/binding lists.

Same-root moves completed within the disconnect grace microtask preserve the
active generation. A real disconnect retires it. Reconnection in another
document or root clears an object-assigned `interactionTarget`, unpublishes the
old event bridge, rebinds styles and observers to the new realm, and starts a
successor only after the retired generation publishes a completed cleanup
receipt. Incomplete cleanup blocks that successor; a later completed receipt
can recover on a subsequent serialized lifecycle operation.
