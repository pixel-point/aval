# React example

This example uses the dedicated `@pixel-point/aval-react` package. The
application gives `useAval()` a codec-keyed source map and receives the
reactive `aval` controller plus a stable bound `AvalComponent`. It does not
render custom-element markup, augment React JSX, register the element, or
install native DOM listeners itself.

```tsx
const { aval, AvalComponent } = useAval({
  sources: {
    av1: "/status/av1.avl",
    vp9: "/status/vp9.avl",
    h265: "/status/h265.avl",
    h264: "/status/h264.avl"
  },
  state: "idle",
  autoplay: true,
  autoBind: true
});
```

The example targets the exact future `@pixel-point/aval-react` 1.0.0 release as
an optional peer so its isolated lockfile remains installable before the
technical preview is published. To use a registry release:

```sh
npm install
npm install @pixel-point/aval-react@1.0.0
npm run typecheck
npm run build
```

Repository release verification installs locally packed React and element
archives instead of substituting source aliases. Version 1.0.0 is not claimed
to exist on a public registry yet.

Place AV1, VP9, H.265, and H.264 `.avl` files defining `idle`, `loading`, and
`done` under `public/status/` to exercise the controls. Missing assets produce
a normalized fatal error and the example renders its own alternate status.
