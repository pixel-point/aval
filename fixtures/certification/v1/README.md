# Qualified certification bundle

This directory is the canonical browser-certification authority for the
current packed-alpha profile. Its AV1, VP9, H.265, and H.264 assets are wire
1.1 files with compiler-produced output-qualification witnesses.

`build.json` records the exact codec order, MIME strings, sizes, digests, and
toolchain invocations. The copies under
`examples/end-user-playground/public/favorite` are consumers of this bundle;
`npm run fixtures:verify` requires every copied byte to remain identical.

`fixtures/conformance/v1` remains the frozen wire-1.0 compatibility authority.
It is intentionally not used for current packed-alpha playback certification.

Run `node fixtures/certification/v1/update-fixture.mjs` after building the
compiler to rebuild into temporary storage, prepare complete authority and
consumer directories, and transactionally swap both with rollback before
retiring the old generation. Run the same command with `--check` to verify the
authority, consumer, and provenance remain synchronized without rewriting them.
