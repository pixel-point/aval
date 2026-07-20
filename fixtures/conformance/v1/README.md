# AVAL 1.0 four-codec bundle

This directory is a real compiler-produced AVAL 1.0 bundle for browser and
playground verification. The four assets contain the same transparent
idle/engaged animation and differ only in their video codec:

1. `av1.avl` — AV1, 10-bit
2. `vp9.avl` — VP9
3. `h265.avl` — H.265/HEVC
4. `h264.avl` — H.264/AVC

`build.json` is the canonical compiler report. Its `assets` array and
`sourceMarkup` preserve that order and contain the exact MIME codec string,
SHA-256 digest, and SRI value for every file. A browser should try the literal
direct-child `<source>` elements in this order and retain the first supported
configuration.

Rebuild from the canonical project with the local FFmpeg toolchain:

```sh
npm run build -w @pixel-point/aval-compiler
AVAL_FIXTURE_TMP="$(mktemp -d /tmp/aval-v1-rebuild.XXXXXX)"
node packages/compiler/dist/cli.js compile \
  fixtures/compiler/v1/source/motion.json \
  --out "$AVAL_FIXTURE_TMP/bundle"
cp "$AVAL_FIXTURE_TMP/bundle/av1.avl" fixtures/conformance/v1/av1.avl
cp "$AVAL_FIXTURE_TMP/bundle/vp9.avl" fixtures/conformance/v1/vp9.avl
cp "$AVAL_FIXTURE_TMP/bundle/h265.avl" fixtures/conformance/v1/h265.avl
cp "$AVAL_FIXTURE_TMP/bundle/h264.avl" fixtures/conformance/v1/h264.avl
cp "$AVAL_FIXTURE_TMP/bundle/build.json" fixtures/conformance/v1/build.json
node fixtures/conformance/v1/update-provenance.mjs
npm run fixtures:verify
```

The compiler publishes a bundle by replacing its output directory. Compile in
temporary storage and copy only generated files so this mixed fixture directory
keeps its README, provenance, and update script.

The exact source bytes and generated outputs are pinned in `provenance.json`.
The source frames are CC0-1.0.
