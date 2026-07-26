# Element API

`aval-player` supports these reflected host attributes: `crossorigin`,
`motion`, `autoplay`, `fit`, `bindings`, `state`,
`interaction-for`, `width`, and `height`. It has no image URL property; an
optional fallback slot belongs to the host document and is not embedded in the
asset.

Assets are literal direct-child `<source>` elements. Each requires `src` and
`type='application/vnd.aval; codecs="..."'`; optional integrity applies to that
source alone. Child order is preference order.

Core methods are `prepare()`, `setState()`, `send()`, `readyFor()`,
`planFor()`, `pause()`, `resume()`, `getDiagnostics()`, and terminal
`dispose()`. Runtime state is read through `readiness`, `mode`, `staticReason`,
`requestedState`, `visualState`, `isTransitioning`, `paused`,
`effectivelyVisible`, `stateNames`, `eventNames`, `inputBindings`, and `rings`.

`rings` lists the ordered state axes the asset declares, each as
`{ id, states, cyclic }`. `planFor(state)` is a dry run of `setState(state)`: it
returns the landings that request would visit, in order, `[]` when the state is
already held, or `null` when there is no route today. It never advances the
graph.

Events are non-cancelable `CustomEvent` instances with immutable bounded
details: `readinesschange`, `requestedstatechange`, `visualstatechange`,
`transitionstart`, `transitionend`, `turnstep`, `underflow`, `fallback`, and
`error`. `turnstep` fires once per landing while a request walks a ring, with
`{ ring, from, to, remaining }`; its pixels are already drawn when it fires. Every
event except `error` bubbles and is composed. Listen for `error` directly on
the element; keeping that event local follows native media behavior and avoids
colliding with page-wide error handlers. Every detail includes a positive
source `generation`; it never contains a source URL, integrity token, response
body, ETag, or credential.

`prepare({ signal, timeoutMs })` joins generation preparation. Aborting one
caller stops only that caller's wait. Child-source replacement rejects old
public waits and prevents old frames or events from publishing.

`getDiagnostics()` exposes an immutable cleanup receipt for the most recently
retired source. A completed receipt proves participant-scoped ownership reached
zero. Page totals are reported separately and may remain nonzero while peer
elements share the page runtime. Cross-document/root adoption clears an
object-only interaction target and receipt-gates the new realm's source; a
same-root same-task move preserves the existing generation.
