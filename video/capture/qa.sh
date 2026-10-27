#!/bin/bash
# capture/qa.sh <mp4> <outdir> "<frame list>" — frames by seeking (Remotion's ffmpeg has no select/tile) + mono wav
D=node_modules/@remotion/compositor-linux-x64-gnu
export LD_LIBRARY_PATH=$D
mkdir -p "$2"; rm -f "$2"/f*.jpg
for f in $3; do $D/ffmpeg -v error -ss $(python3 -c "print(($f+0.5)/30)") -i "$1" -frames:v 1 -q:v 3 -y "$2/f$(printf %04d $f).jpg"; done
uv run -q --with pillow python capture/grid.py "$2/sheet.jpg" "$2"/f*.jpg
$D/ffmpeg -v error -i "$1" -vn -ac 1 -ar 44100 -y "$2/audio.wav"
