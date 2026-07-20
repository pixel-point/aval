# Kinetic orb hover example

This example is a Blender-authored proof of continuous interactive video. A
graphite calibration ball rotates in every state, its meridian seams and shell
light uniformly during hover, and a separately authored forward-playing exit
returns it to idle without reversing or resetting the rotation.

The 512×512 authoring source is opaque H.264 at 24 fps. Compilation publishes
equivalent AV1, VP9, H.265/HEVC, and H.264 `.avl` renditions in that preferred
order. The browser qualifies each source in order and uses H.264 only when none
of the three more modern codecs works. Conservative constant-quality settings
keep independently encoded state boundaries visually quiet:

- AV1 8-bit, CRF 24
- VP9, CRF 26
- H.265/HEVC, CRF 20
- H.264 Constrained Baseline, CRF 16

Every rendition preserves the same authored graph:

- `intro`: `[0, 24)`
- `idle-loop`: `[24, 48)`
- `hover-in`: `[48, 60)`
- `hover-loop`: `[60, 84)`
- `hover-out`: `[84, 96)`

The ball advances exactly 5 degrees on every source frame, including the
intro. Twelve identical great-circle seams make the complete visible object
equivalent every 15 degrees. Loop portals are therefore authored on local
frames `[2, 5, 8, 11, 14, 17, 20, 23]`; hover entry and exit wait at most two
frames, or about 83 ms, for the next safe transition point.

All five units share one absolute source-frame angle. Idle and hover loops use
constant illumination, while the transition endpoints match those exact
levels. The saved `.blend` contains baked linear keyframes from frame -1
through 96 so the editable scene and Blender motion-blur samples preserve the
same forward velocity across every source boundary.

## Regenerate the source

Python 3.10+, Blender 5.1, and FFmpeg with `libaom-av1`, `libvpx-vp9`,
`libx265`, and `libx264` are required. From the repository root:

```sh
npm run render:kinetic-orb
```

The render script first runs the pure timeline contract test, regenerates
`kinetic-orb.blend`, writes 96 PNGs to `source/frames/`, encodes
`source/kinetic-orb.mp4`, and creates a seam contact sheet. The sheet is ordered
by global source frame:

`23, 24, 26, 29, 32, 35, 38, 41, 44, 47, 48, 59, 60, 62, 65, 68, 71, 74, 77, 80, 83, 84, 95`

That sequence contains every unit boundary and all idle/hover portal source
frames; frames 48 and 84 are their respective transition targets. Set
`BLENDER_BIN` when Blender is installed somewhere other than
`/Applications/Blender.app`.

## Compile and preview

```sh
npm run compile:kinetic-orb
npm run kinetic-orb
```

The compiled bundle is written to `public/kinetic-orb/`. Hover the player or
focus it with the keyboard to enter the powered state.
