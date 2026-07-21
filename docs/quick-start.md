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

## Required consumer failure handling

Using AVAL requires an application-owned fatal-error boundary. Unsupported
browsers and exhausted codec qualification reject `prepare()` with
`AvalPlaybackError` and raise one fatal `error` event. AVAL never supplies or
activates alternate presentation, so the application must decide whether to
show a sibling video, image, text, another renderer, or nothing. Install the
direct `error` listener before registering the element, and branch on
`failure.code` such as `unsupported-profile` or `unsupported-browser` rather
than parsing the message.

```html
<script type="module" src="/motion.js"></script>

<aval-player id="motion" width="320" height="320">
  <source src="/my-motion/av1.avl"
    type='application/vnd.aval; codecs="av01.0.00M.10.0.110.01.01.01.0"'>
  <source src="/my-motion/vp9.avl"
    type='application/vnd.aval; codecs="vp09.00.10.08.01.01.01.01.00"'>
  <source src="/my-motion/h265.avl"
    type='application/vnd.aval; codecs="hvc1.1.6.L30.90"'>
  <source src="/my-motion/h264.avl"
    type='application/vnd.aval; codecs="avc1.42E00B"'>
</aval-player>
<img id="motion-unavailable" src="/my-motion.png" alt="" hidden>
```

Use the exact `sourceMarkup` emitted in your bundle's `build.json`; codec levels
depend on the compiled rendition. Candidate selection follows markup order, so
H.264 is attempted only after AV1, VP9, and HEVC are unavailable or fail a
closed provisional codec/output check.

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
[browser support](browser-support.md). See
[failure handling and reduced motion](element/fallback-and-reduced-motion.md)
for the complete consumer-owned fallback contract.
