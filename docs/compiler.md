# Compiler

The CLI supports `init`, `compile`, `dev`, `inspect`, `validate`, and `unpack`.
Project schema `1.0` produces one wire-format `1.1` file per requested codec.

```sh
npx avl init my-motion
npx avl compile my-motion/motion.json --out dist/my-motion
npx avl inspect dist/my-motion/av1.avl
npx avl validate dist/my-motion/av1.avl
```

Inputs are strict JSON projects and author-sized video or PNG sequences. The
compiler normalizes timing, creates independently decodable video units,
validates exact geometry and alpha policy, and atomically publishes the whole
codec bundle. Packed-alpha renditions include a bounded witness verified by
decoding the exact emitted unit; compilation fails if the emitted pixels cannot
support that proof. An
AVAL contains no embedded poster, static image, or host fallback bytes.
Build reports record the resolved FFmpeg/FFprobe fingerprints and quality
results. In explicit projects, visual-seam heuristic misses are reported for
review while author-selected source pixels remain unchanged. Temporary paths do
not enter compiled bytes.

Project `1.0` renditions use CRF. H.264/H.265 expose allowlisted presets, VP9
exposes deadline/CPU controls, and AV1 exposes 8/10-bit, CPU, tile, row-MT, and
thread controls. Direct input requires `--codec` and lowers through the same
one-codec bundle pipeline; arbitrary FFmpeg arguments are not accepted.

New H.264 renditions are always 8-bit 4:2:0 Constrained Baseline and use the
canonical `avc1.42E0xx` codec string. The compiler selects the lowest supported
level that admits the macroblock dimensions, exact rational macroblock rate,
one-reference DPB, and the configured MaxBR/CPB limits. It applies the
compatibility restrictions after the requested preset: one reference, closed
GOPs, no B-pictures, CABAC, weighted prediction, or 8×8 transform, exact crop,
and BT.709 limited-range signalling. The selected level's MaxBR and CPB limits
are emitted as FFmpeg `-maxrate` and `-bufsize`; CRF 0 and renditions outside
the bounded level table fail compilation.

The current permanent compatibility rows are:

| Coded rendition | Frame rate | Emitted codec |
| --- | --- | --- |
| 48×112 | 30 fps | `avc1.42E00B` |
| 512×512 | 24 fps | `avc1.42E01E` |
| 640×368 | 24 fps | `avc1.42E01E` |
| 1280×720 | 24 fps | `avc1.42E01F` |

The format accepts only the compiler's Constrained Baseline H.264 profile.
High-profile declarations are rejected at the asset boundary.

See [preparing video and authoring states](compiler/authoring-video-and-states.md)
for accepted files, timing and alpha requirements, half-open ranges, a complete
multi-state project, exact no-downscale sizing behavior, and consumer code.

FFmpeg, FFprobe, libx264, libx265, libvpx-vp9, and libaom-av1 are caller-owned
tools. Codec patent/licensing obligations are not bundled or cleared by this
project. Use a reviewed local toolchain and obtain legal review for production
distribution.

See [project 1.0](project/1.0.md) and [wire format 1.1](format/1.1.md) for the
exact authoring and payload contracts.
