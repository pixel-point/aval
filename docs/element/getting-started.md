# AVAL element: getting started

Install and explicitly register the exact SSR-safe package release:

```sh
npm install @pixel-point/aval-element@1.0.0
```

```js
import { defineAvalElement } from "@pixel-point/aval-element";

const motion = document.querySelector("#orbit");
const unavailable = document.querySelector("#orbit-unavailable");
motion.addEventListener("readinesschange", () => {
  if (motion.readiness === "interactiveReady") unavailable.hidden = true;
});
motion.addEventListener("error", (event) => {
  const diagnostics = motion.getDiagnostics();
  if (
    event.detail.fatal === true &&
    motion.readiness === "error" &&
    event.detail.failure === diagnostics.lastFailure
  ) {
    unavailable.hidden = false;
  }
});

defineAvalElement();
```

```html
<aval-player id="orbit" width="96" height="96">
  <source
    src="/assets/orbit.h264.avl"
    type='application/vnd.aval; codecs="avc1.42E01E"'
  >
</aval-player>
<img id="orbit-unavailable" src="/assets/orbit.png" alt="" width="96" height="96" hidden>
```

Connection automatically prepares metadata. When animation is supported and
visible, the first revealed internal pixels are a decoded frame and a direct
one-state compile plays its authored intro and body loop without application
code. Network, parser, integrity, capability, or decode failure rejects
`prepare()` with `AvalPlaybackError`; the application can then reveal its
sibling image or choose another response. Reduced motion is a separate
nonfatal policy condition and does not automatically reveal application DOM.
Install the listener before `defineAvalElement()` so an upgrade-time terminal
failure cannot outrun the consumer boundary.

For a browser-only pinned CDN import, use the explicit side-effect entry:

```js
import "https://your-pinned-cdn.example/@pixel-point/aval-element@VERSION/auto";
```

Do not use an unpinned URL in production. Call `dispose()` when an element
instance is permanently retired; it settles only after the terminal cleanup
receipt. Ordinary disconnection already retires the source. A same-root
same-task DOM move preserves it, while a later true reconnect or cross-realm
adoption starts a receipt-gated source generation.
