#!/usr/bin/env bash
set -euo pipefail

example_dir="$(cd "$(dirname "$0")/.." && pwd)"
blender_bin="${BLENDER_BIN:-/Applications/Blender.app/Contents/MacOS/Blender}"

PYTHONDONTWRITEBYTECODE=1 python3 "$example_dir/blender/test_timeline.py"

"$blender_bin" --background --factory-startup --python "$example_dir/blender/generate_scene.py" -- --render

ffmpeg -y \
  -framerate 24 \
  -start_number 0 \
  -i "$example_dir/source/frames/frame-%04d.png" \
  -an \
  -c:v libx264 \
  -preset medium \
  -crf 16 \
  -pix_fmt yuv420p \
  -r 24 \
  -movflags +faststart \
  "$example_dir/source/kinetic-orb.mp4"

ffmpeg -y \
  -i "$example_dir/source/kinetic-orb.mp4" \
  -vf "select='eq(n,23)+eq(n,24)+eq(n,26)+eq(n,29)+eq(n,32)+eq(n,35)+eq(n,38)+eq(n,41)+eq(n,44)+eq(n,47)+eq(n,48)+eq(n,59)+eq(n,60)+eq(n,62)+eq(n,65)+eq(n,68)+eq(n,71)+eq(n,74)+eq(n,77)+eq(n,80)+eq(n,83)+eq(n,84)+eq(n,95)',scale=160:160,tile=6x4:nb_frames=23:margin=4:padding=4:color=black" \
  -frames:v 1 \
  -update 1 \
  "$example_dir/source/contact-sheet.jpg"
