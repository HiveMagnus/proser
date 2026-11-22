#!/bin/bash

# Script to debug Forge API by trying different approaches
FORGE_URL="${FORGE_BASE:-http://127.0.0.1:7860}"

echo "1. Testing basic connectivity..."
curl -s -w "\nHTTP Status: %{http_code}\n" "$FORGE_URL" >/dev/null

echo "2. Checking available endpoints..."
curl -s "$FORGE_URL" | grep -o 'action="[^"]*"' | head -5

echo "3. Testing different txt2img payload formats..."

echo "Testing format 1: Basic txt2img with default parameters"
RESPONSE1=$(curl -s -X POST "$FORGE_URL/call/txt2img" -H "Content-Type: application/json" -d '{
  "data": [
    "A red apple on a table",
    "",
    20,
    512,
    512,
    7.0,
    "Euler a",
    -1,
    -1,
    false,
    false,
    1,
    1,
    false
  ]
}')
echo "Response 1: $RESPONSE1"

if [[ $RESPONSE1 == *"event_id"* ]]; then
  EVENT_ID1=$(echo "$RESPONSE1" | grep -o '"event_id":"[^"]*"' | cut -d'"' -f4)
  echo "Got event ID: $EVENT_ID1"
  sleep 3
  RESULT1=$(curl -s "$FORGE_URL/call/txt2img/$EVENT_ID1")
  echo "Result 1: $RESULT1"
fi

echo ""
echo "Testing format 2: Minimal parameters"
RESPONSE2=$(curl -s -X POST "$FORGE_URL/call/txt2img" -H "Content-Type: application/json" -d '{
  "data": ["A red apple on a table", "", 20]
}')
echo "Response 2: $RESPONSE2"

if [[ $RESPONSE2 == *"event_id"* ]]; then
  EVENT_ID2=$(echo "$RESPONSE2" | grep -o '"event_id":"[^"]*"' | cut -d'"' -f4)
  echo "Got event ID: $EVENT_ID2"
  sleep 3
  RESULT2=$(curl -s "$FORGE_URL/call/txt2img/$EVENT_ID2")
  echo "Result 2: $RESULT2"
fi

echo ""
echo "Testing format 3: Different parameter order"
RESPONSE3=$(curl -s -X POST "$FORGE_URL/call/txt2img" -H "Content-Type: application/json" -d '{
  "data": [
    "A red apple on a table",
    "",
    20,
    7.0,
    512,
    512,
    "Euler a"
  ]
}')
echo "Response 3: $RESPONSE3"

if [[ $RESPONSE3 == *"event_id"* ]]; then
  EVENT_ID3=$(echo "$RESPONSE3" | grep -o '"event_id":"[^"]*"' | cut -d'"' -f4)
  echo "Got event ID: $EVENT_ID3"
  sleep 3
  RESULT3=$(curl -s "$FORGE_URL/call/txt2img/$EVENT_ID3")
  echo "Result 3: $RESULT3"
fi

echo ""
echo "Done testing different formats."
