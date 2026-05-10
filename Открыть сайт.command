#!/bin/zsh
SITE_DIR="$(cd "$(dirname "$0")" && pwd)/public"
lsof -ti tcp:8080 | xargs kill -9 2>/dev/null; sleep 0.2
python3 -m http.server 8080 --directory "$SITE_DIR" &>/dev/null &
sleep 0.5
open "http://localhost:8080"
wait
