#!/bin/sh
# X client script launched by depdash-kiosk.service via `startx`. Disables
# screen blanking (a factory floor screen must never sleep) and launches
# Chromium in kiosk mode pointed at the local backend.
#
# --no-sandbox is required because this runs as root (this is a
# single-purpose kiosk board with no other users - see README for the
# tradeoff). --disable-dev-shm-usage guards against the board's small
# /dev/shm given the Sige1's 2GB RAM.

xset -dpms
xset s off
xset s noblank

exec chromium \
  --kiosk \
  --noerrdialogs \
  --disable-translate \
  --no-first-run \
  --fast \
  --fast-start \
  --disable-infobars \
  --disable-features=TranslateUI \
  --disk-cache-dir=/tmp/chromium-cache \
  --no-sandbox \
  --disable-dev-shm-usage \
  http://localhost:3000
