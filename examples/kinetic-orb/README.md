# Kinetic orb hover example

This example is a Blender-authored proof of continuous interactive video. A
graphite orb rotates in every state, its inner shell powers on during hover,
and a separately authored forward-playing exit returns it to idle without
reversing the rotation.

The 512×512 source is opaque H.264 at 24 fps. The first proof compiles only an
H.264 `.avl` rendition:

- `intro`: `[0, 24)`
- `idle-loop`: `[24, 48)`
- `hover-in`: `[48, 60)`
- `hover-loop`: `[60, 84)`
- `hover-out`: `[84, 96)`

The orb advances 15 degrees per frame after the intro. Its repeated rib
geometry is visually equivalent every 30 degrees, so loop portals are authored
after every odd frame. Hover entry and exit therefore wait at most one frame,
or about 42 ms, for a safe transition point.

## Regenerate the source

Blender 5.1 and FFmpeg with `libx264` are required. From the repository root:

```sh
npm run render:kinetic-orb
```

The render script regenerates `kinetic-orb.blend`, writes 96 PNGs to
`source/frames/`, encodes `source/kinetic-orb.mp4`, and creates a seam contact
sheet. Set `BLENDER_BIN` when Blender is installed somewhere other than
`/Applications/Blender.app`.

## Compile and preview

```sh
npm run compile:kinetic-orb
npm run kinetic-orb
```

The compiled bundle is written to `public/kinetic-orb/`. Hover the player or
focus it with the keyboard to enter the powered state.
