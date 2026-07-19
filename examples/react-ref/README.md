# React ref example

This example keeps React integration at the application boundary. It uses the
public custom-element definition function, a typed ref, native DOM event
listeners, a controlled authored `state`, and component-owned error UI outside
the custom element.
It does not require or publish a React wrapper.

The callback ref installs listeners during React's commit before defining the
element. That ordering also catches queued connection failures when the element
was already defined by another instance, and the returned cleanup removes the
listeners on unmount.

The example targets the exact future `@pixel-point/aval-element` 1.0.0 release.
That package is an optional peer only so this directory can keep an honest,
isolated lockfile before the prototype is published. Install the exact element
package before typechecking or running the application:

```sh
npm install
npm install @pixel-point/aval-element@1.0.0
npm run typecheck
npm run build
npm exec vite
```

Version 1.0.0 is not claimed to exist on a public registry yet. Repository CI
uses `scripts/verify-packed.mjs` with the locally built 1.0.0 package archives,
so it verifies the package users will install without substituting source-path
aliases or private imports.

Place an AV1, VP9, H.265, and H.264 bundle defining `idle`, `loading`, and
`done` at `public/status/` to exercise the three controls. Use the exact
`<source>` markup recorded in its `build.json`. Without those assets, the
example handles the normalized failure and renders its own alternate status.
