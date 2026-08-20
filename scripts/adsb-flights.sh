#!/usr/bin/env bash

set -euo pipefail

# ADS-B.lol point query centered on the split-flap location.
LATITUDE="43.7398976"
LONGITUDE="-116.3878331"
RADIUS_KM="10"

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
          (.dst // 0),
          (.alt_geom // "UNKNOWN"),
          (.gs  // "UNKNOWN")
        ]
      | @tsv
    '
}

send_flight() {
  local hex="$1"
  local flight="$2"
  local type="$3"
  local distance="$4"
  local altitude="$5"
  local groundspeed="$6"

  # Keep the display compact. ADS-B distance is in nautical miles in the
  # API response, so label it as NM rather than implying statute miles.
  local text=$'\u2708\uFE0F'" "${flight}$'\n'${type}$'\n'${distance}" nm"$'\n'"ALT "${altitude}$'\n'"GRND SPD "${groundspeed}

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

aircraft_lookup() {
	# Configuration
	DATA_URL="https://raw.githubusercontent.com/jpatokal/openflights/refs/heads/master/data/planes.dat"
	DATA_FILE="planes.dat"
	
	# Check if data file exists; download if missing
	if [ ! -f "$DATA_FILE" ]; then
		echo "Downloading aircraft database..." >&2
		curl -s "$DATA_URL" -o "$DATA_FILE"
	fi
	
	# Check for user input
	if [ -z "$1" ]; then
		echo "Usage: $0 <aircraft_code>"
		echo "Example: $0 A320  (or $0 320)"
		exit 1
	fi
	
	# Convert search term to uppercase
	SEARCH_CODE=$(echo "$1" | tr '[:lower:]' '[:upper:]')
	
	#echo "Searching for code: $SEARCH_CODE..."
	#echo "-----------------------------------"
	
	# Parse the CSV file (Format: "Name","IATA","ICAO")
	# Matches the search code in either the IATA (field 2) or ICAO (field 3)
	awk -v code="$SEARCH_CODE" -F',' '
	BEGIN { found = 0 }
	{
		# Strip quotes from fields
		gsub(/"/, "", $1)
		gsub(/"/, "", $2)
		gsub(/"/, "", $3)
		
		if ($2 == code || $3 == code) {
	#        printf "✈️  Name: %s\n   IATA: %s | ICAO: %s\n\n", $1, $2, $3
			printf "%s", $1
			found = 1
		}
	}
	END { if (found == 0) printf "" }
	' "$DATA_FILE"
}

while true; do
  if flights=$(fetch_flights); then
    while IFS=$'\t' read -r hex flight type distance altitude groundspeed; do
      [[ -n "$hex" ]] || continue
      typetext=$(aircraft_lookup "$type")

      if [ -z "$typetext" ]; then
	    typetext="$type"
      fi

   	  send_flight "$hex" "$flight" "$typetext" "$distance" "$altitude" "$groundspeed" || \
      printf 'Unable to send flight %s to split-flap API\n' "$flight" >&2
    done <<< "$flights"
  else
    printf 'Unable to retrieve ADS-B data from %s\n' "$ADSB_URL" >&2
  fi

  sleep "$POLL_SECONDS"
done
