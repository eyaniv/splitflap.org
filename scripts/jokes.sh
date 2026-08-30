#!/usr/bin/env bash

# Split-flap API settings. Override these with environment variables if desired.
SPLITFLAP_API_BASE="${SPLITFLAP_API_BASE:-http://localhost:3000}"
SPLITFLAP_BOARD_ID="${SPLITFLAP_BOARD_ID:-LCL836}"
SPLITFLAP_API_SECRET="${SPLITFLAP_API_SECRET:-}"

MESSAGE_URL="${SPLITFLAP_API_BASE%/}/api/board/${SPLITFLAP_BOARD_ID}/messages"

curl_args=(
  --silent
  --show-error
  --fail
  --max-time 15
)

if [[ -n "$SPLITFLAP_API_SECRET" ]]; then
  curl_args+=(--header "X-API-Secret: ${SPLITFLAP_API_SECRET}")
fi

JOKES_URL="https://api.humorapi.com/jokes/random?api-key=8714f823c27a4ad9a2fb9549940d2313&max-length=115&include-tags=one_liner&min-rating=7&exclude-tags=nsfw"

joke=$(curl "${curl_args[@]}" "$JOKES_URL" | jq -r .joke | fold -s -w 22)

payload=$(jq -n \
    --arg id "joke" \
    --arg text "$joke" \
    '{id: $id, text: $text}')

curl "${curl_args[@]}" \
    --header "Content-Type: application/json" \
    --data "$payload" \
    "$MESSAGE_URL" >/dev/null
