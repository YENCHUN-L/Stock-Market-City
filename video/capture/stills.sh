#!/bin/bash
# Usage: capture/stills.sh UsFilm us "60 230 ..."  → out/qa/<m>-<frame>.png + contact sheet
comp=$1; m=$2; frames=$3
npx remotion bundle src/index.ts --out-dir=out/bundle >/dev/null 2>&1 || npx remotion bundle src/index.ts out/bundle >/dev/null 2>&1
for f in $frames; do npx remotion still out/bundle $comp out/qa/$m-$f.jpg --frame=$f --image-format=jpeg --log=error & done; wait
