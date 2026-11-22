#!/bin/bash
set -e

echo "=== Testing Forge Gradio txt2img with EMPTY parameters ==="

# Test with completely empty parameters array
echo "Testing txt2img with empty array..."
CALL_RESPONSE=$(curl -s -X POST "${FORGE_BASE:-http://127.0.0.1:7860}/call/txt2img" \
  -H "Content-Type: application/json" \
  -d '{"data": []}' \
  --connect-timeout 10 \
  --max-time 30)

echo "Call response: $CALL_RESPONSE"

EVENT_ID=$(echo "$CALL_RESPONSE" | grep -o '"event_id":"[^"]*"' | cut -d'"' -f4)
if [ -n "$EVENT_ID" ]; then
  echo "Got event ID: $EVENT_ID"
  echo "Polling for result..."
  
  for i in {1..10}; do
    sleep 2
    POLL_RESPONSE=$(curl -s "${FORGE_BASE:-http://127.0.0.1:7860}/call/txt2img/$EVENT_ID" \
      --connect-timeout 10 \
      --max-time 10 || echo "curl failed")
    echo "Poll $i response: $POLL_RESPONSE"
    
    # Check if we got a result
    if echo "$POLL_RESPONSE" | grep -q '"event": "complete"'; then
      echo "Generation complete!"
      break
    elif echo "$POLL_RESPONSE" | grep -q '"event": "error"'; then
      echo "Generation error detected"
      break
    fi
  done
else
  echo "No event ID found in response"
fi

echo -e "\n=== Test complete ==="
