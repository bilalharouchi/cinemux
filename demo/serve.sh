#!/bin/sh
# Serves the repo for the demo. `--cors` allows loading an MKV from another
# origin; `-s` silences the access log (one playback = hundreds of Range
# requests, unreadable otherwise).
cd "$(dirname "$0")/.." || exit 1
npm run build && npx --yes http-server -p 8899 -s --cors .
