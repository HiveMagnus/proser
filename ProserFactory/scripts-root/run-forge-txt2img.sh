#!/usr/bin/env bash
# Direct Forge txt2img test using Gradio /call API with config-driven data array
# Requirements: node >=18 (fetch in Node), jq, curl

set -euo pipefail

BASE_URL=${FORGE_BASE:-"http://127.0.0.1:7860"}
OUT_DIR=${OUT_DIR:-"/tmp/forge-test"}
API_NAME=${API_NAME:-"txt2img"}
PROMPT=${PROMPT:-"a scenic landscape, detailed, 4k"}
NEGATIVE=${NEGATIVE:-"lowres, blurry, bad anatomy"}
WIDTH=${WIDTH:-512}
HEIGHT=${HEIGHT:-512}
STEPS=${STEPS:-20}
CFG=${CFG:-7}
SAMPLER=${SAMPLER:-"Euler"}
POLL_MAX=${POLL_MAX:-60}
SLEEP=${SLEEP:-2}

mkdir -p "$OUT_DIR"
BODY_JSON=$(node "$(dirname "$0")/forge/config-to-data.mjs" \
  --base "$BASE_URL" --api "$API_NAME" \
  --prompt "$PROMPT" --neg "$NEGATIVE" \
  --width "$WIDTH" --height "$HEIGHT" \
  --steps "$STEPS" --cfg "$CFG" --sampler "$SAMPLER")

API_USED=$(echo "$BODY_JSON" | jq -r '.api_name')
DATA_ARRAY=$(echo "$BODY_JSON" | jq -c '.data')
CALL_PAYLOAD=$(jq -nc --argjson data "$DATA_ARRAY" '{data: $data}')

echo "Calling /call/${API_USED} ..."
CALL_RES=$(curl -sS -X POST "$BASE_URL/call/${API_USED}" \
  -H 'content-type: application/json' \
  --data "$CALL_PAYLOAD")

EVENT_ID=$(echo "$CALL_RES" | jq -r '.event_id // empty')
if [[ -z "$EVENT_ID" || "$EVENT_ID" == "null" ]]; then
  echo "No event_id returned. Raw: $CALL_RES" >&2
  exit 3
fi

echo "event_id=$EVENT_ID"

echo "Polling results ..."
for ((i=1; i<=POLL_MAX; i++)); do
  RES=$(curl -sS "$BASE_URL/call/${API_USED}/$EVENT_ID" || true)
  # Expect SSE-like lines: "event: <type>" then "data: <payload>"
  STATUS=$(echo "$RES" | sed -n 's/^event: //p' | head -n1 | tr -d '\r')
  DATA_LINE=$(echo "$RES" | sed -n 's/^data: //p' | tr -d '\r')
  echo "[$i] status=${STATUS:-unknown}"

  if [[ "$STATUS" == "progress" || -z "$STATUS" ]]; then
    sleep "$SLEEP"
    continue
  fi

  if [[ "$STATUS" == "error" ]]; then
    echo "$RES" >&2
    echo "Forge returned error." >&2
    exit 4
  fi

  if [[ "$STATUS" == "complete" ]]; then
    # DATA_LINE should contain a JSON payload
    if [[ -z "$DATA_LINE" || "$DATA_LINE" == "null" ]]; then
      echo "No data payload returned on completion." >&2
      exit 6
    fi
    echo "$DATA_LINE" | jq . > "$OUT_DIR/result.json" || {
      echo "$DATA_LINE" > "$OUT_DIR/result.raw";
    }

    # Try parse images from various shapes from the JSON
    COUNT=0
    if jq -e . >/dev/null 2>&1 <<<"$DATA_LINE"; then
      echo "$DATA_LINE" | jq -r '.images[]? // empty' | while read -r img; do
        if [[ -n "$img" ]]; then
          COUNT=$((COUNT+1))
          echo "$img" | sed -e 's/^data:image\/png;base64,//' -e 's/^data:image\/jpeg;base64,//' | base64 -d > "$OUT_DIR/image_${COUNT}.png" || true
        fi
      done
      if [[ $COUNT -eq 0 ]]; then
        idx=0
        for item in $(echo "$DATA_LINE" | jq -c '.data[]?'); do
          val=$(echo "$item" | jq -r 'select(type=="string")') || true
          if [[ -n "$val" ]]; then
            idx=$((idx+1))
            echo "$val" | sed -e 's/^data:image\/png;base64,//' -e 's/^data:image\/jpeg;base64,//' | base64 -d > "$OUT_DIR/data_${idx}.png" || true
            COUNT=$((COUNT+1))
          fi
        done
      fi
    fi

    echo "Saved $COUNT image(s) under $OUT_DIR";
    exit 0
  fi

  sleep "$SLEEP"
done

echo "Timed out waiting for completion." >&2
exit 5
