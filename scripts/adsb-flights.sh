#!/usr/bin/env bash

set -euo pipefail

# ADS-B.lol point query centered on the split-flap location.
LATITUDE="43.7398976"
LONGITUDE="-116.3878331"
RADIUS_KM="15"

# Split-flap API settings. Override these with environment variables if desired.
SPLITFLAP_API_BASE="${SPLITFLAP_API_BASE:-http://localhost:3000}"
SPLITFLAP_BOARD_ID="${SPLITFLAP_BOARD_ID:-LCL836}"
SPLITFLAP_API_SECRET="${SPLITFLAP_API_SECRET:-}"

# Poll once per minute. A 2-minute TTL gives an aircraft one missed poll
# without immediately disappearing from the board.
POLL_SECONDS="${POLL_SECONDS:-60}"
MESSAGE_TTL="${MESSAGE_TTL:-120}"

ADSB_URL="https://api.adsb.lol/v2/point/${LATITUDE}/${LONGITUDE}/${RADIUS_KM}"
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

fetch_flights() {
  curl "${curl_args[@]}" "$ADSB_URL" |
    jq -r '
      .ac[]?
      | select(.hex != null)
      | [
          .hex,
          ((.flight // "UNKNOWN") | gsub("^\\s+|\\s+$"; "")),
          (.t // "UNKNOWN"),
          (.dst // 0)
        ]
      | @tsv
    '
}

send_flight() {
  local hex="$1"
  local flight="$2"
  local type="$3"
  local distance="$4"

  # Keep the display compact. ADS-B distance is in nautical miles in the
  # API response, so label it as NM rather than implying statute miles.
  local text="${flight} ${type} ${distance}nm"

  local payload
  payload=$(jq -n \
    --arg id "adsb-${hex}" \
    --arg text "$text" \
    --argjson ttl "$MESSAGE_TTL" \
    '{id: $id, text: $text, ttl: $ttl}')

  curl "${curl_args[@]}" \
    --header "Content-Type: application/json" \
    --data "$payload" \
    "$MESSAGE_URL" >/dev/null
}

while true; do
  if flights=$(fetch_flights); then
    while IFS=$'\t' read -r hex flight type distance; do
      [[ -n "$hex" ]] || continue
      send_flight "$hex" "$flight" "$type" "$distance" || \
        printf 'Unable to send flight %s to split-flap API\n' "$flight" >&2
    done <<< "$flights"
  else
    printf 'Unable to retrieve ADS-B data from %s\n' "$ADSB_URL" >&2
  fi

  sleep "$POLL_SECONDS"
done
