#!/usr/bin/env bash
# Frames (PNG, numbered) -> optimized looping GIF.
# Usage: encode.sh <frames-dir> <fps> <width> <out.gif>
set -euo pipefail
dir=$1; fps=$2; width=$3; out=$4
filters="fps=${fps},scale=${width}:-1:flags=lanczos"
ffmpeg -y -loglevel error -framerate "$fps" -i "$dir/f%04d.png" -vf "${filters},palettegen=max_colors=${COLORS:-128}:stats_mode=diff" "$dir/palette.png"
ffmpeg -y -loglevel error -framerate "$fps" -i "$dir/f%04d.png" -i "$dir/palette.png" -lavfi "${filters} [x]; [x][1:v] paletteuse=dither=sierra2_4a:diff_mode=rectangle" -loop 0 "$out"
ls -la "$out" | awk '{printf "%s bytes %s\n", $5, $9}'
