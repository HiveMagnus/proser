#!/usr/bin/env bash
set -euo pipefail

API_BASE=${API_BASE:-http://localhost:3001/api}
PROMPT=${PROMPT:-"A futuristic city at sunset with flying cars."}
SIZE=${SIZE:-"512x512"}

mkdir -p /tmp/proser || true

json_payload=$(jq -cn --arg prompt "$PROMPT" --arg size "$SIZE" '{model:"dall-e-3", prompt:$prompt, n:1, size:$size, quality:"standard", response_format:"url"}')

resp=$(curl -sS --max-time 180 -X POST "$API_BASE/images/generate" \
  -H 'Content-Type: application/json' \
  -H 'x-user-id: 1' -H 'x-github-id: local-123' \
  --data "$json_payload")

url=$(echo "$resp" | jq -r '.data.data[0].url // empty')
echo "$url"
if [ -n "$url" ]; then
  echo "$url" > /tmp/proser/last-image-url.txt || true
fi
echo "$resp" > /tmp/proser/last-image-response.json || true
