# Element API

`aval-player` supports these reflected host attributes: `crossorigin`,
`motion`, `autoplay`, `fit`, `bindings`, `state`,
`interaction-for`, `width`, and `height`. It has no image URL property; an
application may keep alternate content beside the element, but AVAL never
selects or manipulates it.

Assets are literal direct-child `<source>` elements. Each requires `src` and
`data-codec="av1|vp9|h265|h264"`; optional integrity applies to that source
alone. Each family may appear once. Child order has no priority meaning: AVAL
always evaluates AV1 → VP9 → H.265 → H.264.

Core methods are `prepare()`, `setState()`, `send()`, `readyFor()`, `pause()`,
`resume()`, `getDiagnostics()`, and terminal `dispose()`. Runtime state is read
through `readiness`, `mode`, `staticReason`, `requestedState`, `visualState`,
`isTransitioning`, `paused`, `effectivelyVisible`, `stateNames`, `eventNames`,
and `inputBindings`.

Events are non-cancelable `CustomEvent` instances with immutable bounded
details: `readinesschange`, `requestedstatechange`, `visualstatechange`,
`transitionstart`, `transitionend`, `underflow`, and `error`. Every
event except `error` bubbles and is composed. Listen for `error` directly on
the element; keeping that event local follows native media behavior and avoids
colliding with page-wide error handlers. Every detail includes a positive
source `generation`; it never contains a source URL, integrity token, response
body, ETag, or credential.

`prepare({ signal, timeoutMs })` joins generation preparation. Aborting one
caller stops only that caller's wait. Child-source replacement rejects old
public waits and prevents old frames or events from publishing.

A terminal capability or playback failure rejects `prepare()` with the
exported `AvalPlaybackError`, changes readiness to `error`, and dispatches one
fatal `error` event. Its frozen `failure` value is shared with the event and
diagnostics. Applications branch on `error.failure.code`; they do not parse the
message. Reduced-motion and visibility suspension remain nonfatal policy
conditions and do not mean AVAL supplied a static presentation.

`getDiagnostics()` exposes an immutable cleanup receipt for the most recently
retired source. A completed receipt proves participant-scoped ownership reached
zero. Page totals are reported separately and may remain nonzero while peer
elements share the page runtime. Cross-document/root adoption clears an
object-only interaction target and receipt-gates the new realm's source; a
same-root same-task move preserves the existing generation.
