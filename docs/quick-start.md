# Quick start

Install the element and compiler at the synchronized 1.0 version:

```sh
npm install @pixel-point/aval-element@1.0.0
npm install --save-dev @pixel-point/aval-compiler@1.0.0
npx avl init my-motion
cd my-motion
npm install
npm run dev
```

Here `npx avl` resolves the `avl` executable from the compiler package
installed on the preceding line.

Open the printed loopback URL. Browsers can treat HTTP loopback as potentially
trustworthy, but copying the server's private-LAN address to a phone is not the
same security context. Use HTTPS through a trusted local certificate or tunnel
when testing on another device. This is the immediately runnable end-to-end
path: the generated directory includes source frames, project, exact package
dependencies, and watch compiler. When integrating the built asset into a
package-aware web application, register the element once and use ordinary
markup like this illustrative snippet:

```html
<script type="module" src="/motion.js"></script>

<aval-player id="motion" width="320" height="320">
  <source
    src="/my-motion/h264.avl"
    type='application/vnd.aval; codecs="avc1.42E01E"'
  >
</aval-player>
<img id="motion-unavailable" src="/my-motion.png" alt="" hidden>
```

```js
// motion.js, resolved by your package-aware web build
import { AvalPlaybackError, defineAvalElement } from "@pixel-point/aval-element";

const motion = document.querySelector("#motion");
const unavailable = document.querySelector("#motion-unavailable");
motion.addEventListener("error", (event) => {
  if (event.detail.fatal) unavailable.hidden = false;
});
motion.addEventListener("readinesschange", () => {
  if (motion.readiness === "interactiveReady") unavailable.hidden = true;
});
defineAvalElement();

try {
  await motion.prepare();
} catch (error) {
  if (!(error instanceof AvalPlaybackError)) throw error;
}
```

A one-state compiled body loops without JavaScript seeking or a loop range.
The package root is SSR-safe and has no registration side effect. Client-only
pages may instead import `@pixel-point/aval-element/auto`.

The compiler requires a caller-installed FFmpeg/FFprobe build with libx264. It
never downloads or bundles native tools. See [compiler setup](compiler.md) and
[browser support](browser-support.md).
