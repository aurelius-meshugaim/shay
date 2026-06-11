#!/usr/bin/env bash
# Serve ~/shay publicly via a Cloudflare quick-tunnel.
# Run:  bash ~/shay/serve.sh    (Ctrl+C to stop)
cd ~/shay || exit 1

# start the static server only if 8080 isn't already serving
if ! curl -sf -o /dev/null http://localhost:8080/ 2>/dev/null; then
  python3 -m http.server 8080 >/tmp/shaysrv.log 2>&1 &
  sleep 1
fi

LOG=/tmp/shay-tunnel.log
: > "$LOG"
echo "Starting public tunnel… (this can take ~10s)"
npx -y cloudflared@latest tunnel --url http://localhost:8080 >"$LOG" 2>&1 &
TPID=$!

URL=""
for i in $(seq 1 30); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1)
  [ -n "$URL" ] && break
  sleep 1
done

echo
if [ -n "$URL" ]; then
  echo "=================================================================="
  echo "  OPEN THIS IN YOUR BROWSER:"
  echo
  echo "      $URL"
  echo
  echo "=================================================================="
  echo "  (leave this terminal open; press Ctrl+C to stop)"
else
  echo "Tunnel didn't print a URL — see $LOG"
fi

wait "$TPID"
