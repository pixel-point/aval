# Plain HTML example

This source example is illustrative: it is ordinary HTML, CSS, and JavaScript
with a package-aware development server—no framework and no inline script or
style exception. Its bundle paths and asset files are illustrative
placeholders; the `data-codec` family labels are the required AVAL contract.

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

In production, use each `data-codec` family and optional `integrity` from
`orbit/build.json.sourceMarkup`. AVAL applies its fixed family priority, so DOM
order does not change codec selection.

For an immediately runnable generated asset and browser workflow, use
`avl init` and `npm run dev` in the generated starter.
