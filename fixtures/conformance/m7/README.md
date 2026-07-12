# M7 loader, integrity, and resource fixture

`reference-packed.rma` is byte-identical to the reviewed M6
`packed-alpha-all-routes.rma` compiler output. M7 reuses those canonical 0.1
bytes so transport, sparse residency, internal digests, static-first order,
and page-budget behavior can be tested without introducing a second encoder or
hand-edited binary.

`reference-packed.provenance.json` freezes the complete-file digest, external
integrity token, metadata geometry, every canonical blob and preceding padding
span, exact range plans, selected-rendition byte totals, and inherited FFmpeg
toolchain identity. `network-scenarios.json` records server behaviors only;
the test server derives bounded mutations from the single checked asset.

Regenerate or verify with:

```sh
node fixtures/conformance/m7/update-provenance.mjs
node fixtures/conformance/m7/update-provenance.mjs --check
```

Binary and provenance changes must be reviewed together. Do not hand-edit the
`.rma` file or persist mutated scenario copies.
