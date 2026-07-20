# Plain HTML example

This source example is illustrative: it is ordinary HTML, CSS, and JavaScript
with a package-aware development server—no framework and no inline script or
style exception. Its bundle paths and codec strings are illustrative
placeholders.

Compile or copy an `orbit` bundle directory containing one `.avl` per codec and
an optional consumer-owned alternate image `orbit.png` into this directory,
then run:

```sh
npm install
npm run dev
```

Vite resolves the public `@pixel-point/aval-element` package import. A browser
cannot resolve a bare npm specifier by opening `index.html` from disk; use this
workflow, another package-aware bundler, or an exact pinned CDN URL.

In production, replace each illustrative `type` with the exact value from
`orbit/build.json` and add that asset's reported `integrity`. The compiler's
`sourceMarkup` field provides the ordered source lines directly.

For an immediately runnable generated asset and browser workflow, use
`avl init` and `npm run dev` in the generated starter.
