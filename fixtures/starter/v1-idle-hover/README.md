# AVAL idle/hover starter

The state names (`idle` and `engaged`) and event names
(`control.engage` and `control.release`) are ordinary author data. The
runtime does not contain a special hover state.

Build the four-codec AV1, VP9, H.265, and H.264 bundle, then open the starter page:

```sh
npm install
npm run build
npm run validate
npm run preview
```

The compiler writes one asset per codec plus `motion/build.json`. Before the
element is defined, `main.js` copies each asset path and integrity digest from
that report onto the literal `<source>` children. Each child keeps its required
`data-codec` family declaration. The player has no host `src` or host
`integrity` attribute.

`npm run dev` runs the compiler's watch/browser workflow. The included
`index.html` is the package-aware Vite entry used by `npm run preview`. It
demonstrates a native button as the semantic interaction target and a light-DOM
alternate image that the starter itself reveals after a fatal playback error.

The generated RGBA frames are CC0-1.0 and their exact provenance is recorded
in `provenance.json`. No upload, account, framework, or remote asset is
required.
