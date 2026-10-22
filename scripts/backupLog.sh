#!/bin/sh
# Download the production log (the whole off-chain state) and keep 30 days of
# daily copies. Run it daily, e.g. from launchd or cron.
#
#   ANTHILL_BACKEND  backend URL (default https://anthill-backend-5rjq.onrender.com)
#   ANTHILL_BACKUPS  folder for the copies (default ~/anthill-backups)
#   ADMIN_TOKEN      or the file ~/.anthill-admin-token (Render dashboard →
#                    anthill-backend → Environment → ADMIN_TOKEN)
#
# To restore: stop the service, put a copy back as $DATA_DIR/log.jsonl, start it.
set -eu

backend="${ANTHILL_BACKEND:-https://anthill-backend-5rjq.onrender.com}"
dir="${ANTHILL_BACKUPS:-$HOME/anthill-backups}"
token="${ADMIN_TOKEN:-$(cat "$HOME/.anthill-admin-token")}"

mkdir -p "$dir"
out="$dir/log-$(date +%Y-%m-%d).jsonl"
curl -fsS --max-time 120 -H "Authorization: Bearer $token" "$backend/admin/log" -o "$out.part"
# refuse to keep an empty download
test -s "$out.part"
mv "$out.part" "$out"
find "$dir" -name 'log-*.jsonl' -mtime +30 -delete
echo "saved $out ($(wc -l < "$out" | tr -d ' ') entries)"
