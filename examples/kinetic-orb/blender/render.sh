#!/usr/bin/env bash
set -euo pipefail

example_dir="$(cd "$(dirname "$0")/.." && pwd)"
blender_bin="${BLENDER_BIN:-/Applications/Blender.app/Contents/MacOS/Blender}"

"$blender_bin" --background --python "$example_dir/blender/generate_scene.py" -- --render

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
  -vf "select='eq(n,23)+eq(n,24)+eq(n,47)+eq(n,48)+eq(n,59)+eq(n,60)+eq(n,83)+eq(n,84)+eq(n,95)',scale=256:256,tile=3x3" \
  -frames:v 1 \
  -update 1 \
  "$example_dir/source/contact-sheet.jpg"
