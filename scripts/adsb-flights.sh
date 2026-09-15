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
MESSAGE_PRIORITY="${MESSAGE_PRIORITY:-low}"

# How long to trust a cached lookup before re-querying.
# Aircraft type/owner (from adsbdb) is effectively static -> cache it a
# long time. Route (from AeroAPI, keyed by callsign) is stable for the
# life of a single flight but a reused flight number can mean something
# different tomorrow, so a shorter TTL avoids re-querying a loitering
# aircraft every poll while still refreshing across days.
AIRCRAFT_CACHE_TTL="${AIRCRAFT_CACHE_TTL:-86400}"   # 24h
ROUTE_CACHE_TTL="${ROUTE_CACHE_TTL:-21600}"         # 6h

# FlightAware AeroAPI, used for route (origin/destination) only -- it
# reflects the actual filed/flown leg instead of a static flight-number
# table. Sign up at flightaware.com/aeroapi (Personal tier) for a key.
# If AEROAPI_KEY is unset, route lookups are skipped and the board just
# omits that line.
AEROAPI_BASE="${AEROAPI_BASE:-https://aeroapi.flightaware.com/aeroapi}"
AEROAPI_KEY="${AEROAPI_KEY:-}"

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

# In-memory caches (associative arrays). These live for the life of the
# service process, which is fine since this runs as a long-lived loop.
declare -A AIRCRAFT_CACHE=()       # hex -> "manufacturer|owner"
declare -A AIRCRAFT_CACHE_TIME=()  # hex -> epoch seconds
declare -A ROUTE_CACHE=()          # callsign -> "origin|destination"
declare -A ROUTE_CACHE_TIME=()     # callsign -> epoch seconds

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
  local owner="$7"
  local origin="$8"
  local destination="$9"

  # The board only has 6 lines. Flight, type, distance, altitude, ground
  # speed, and owner already use all 6 on their own, so adding a route
  # line means combining two fields onto one to stay in budget. Distance
  # and altitude are the two shortest/most-related values, so they share
  # a line. ADS-B distance is in nautical miles, so label it NM rather
  # than implying statute miles.
  local lines=()
  lines+=("$(printf '%s %s' $'\u2708\uFE0F' "$flight")")
  lines+=("$type")
  if [[ -n "$origin" && -n "$destination" ]]; then
    lines+=("${origin} > ${destination}")
  fi
  #lines+=("$(printf '%s nm  ALT %s' "$distance" "$altitude")") #combined line
  lines+=("$(printf 'Distance %s nm' "$distance")")
  lines+=("$(printf 'Altitude %s' "$altitude")")
  lines+=("$(printf 'GRND SPD %s' "$groundspeed")")
  lines+=("$owner")

  # Safety cap in case a future field gets added without adjusting the
  # combining above -- never send more than 6 lines.
  if (( ${#lines[@]} > 6 )); then
    lines=("${lines[@]:0:6}")
  fi

  local text
  text=$(printf '%s\n' "${lines[@]}")
  text="${text%$'\n'}"  # drop the trailing newline printf adds

  local payload
  payload=$(jq -n \
    --arg id "adsb-${hex}" \
    --arg text "$text" \
    --argjson ttl "$MESSAGE_TTL" \
    --arg priority "$MESSAGE_PRIORITY" \
    '{id: $id, text: $text, ttl: $ttl, priority: $priority}')

  echo $payload
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

# Looks up aircraft manufacturer/owner from adsbdb, by Mode S hex.
# adsbdb's aircraft data (unlike its flightroute data) is a registration
# database, not a flight-number->route table, so it isn't exposed to the
# same staleness problem -- fine to keep using it for this part.
# Cached by hex with a long TTL since this rarely changes.
#
# Prints 2 tab-separated fields: manufacturer, owner
adsbdb_lookup() {
	local hex="$1"
	local now
	now=$(date +%s)

	if [[ -n "${AIRCRAFT_CACHE[$hex]:-}" ]] &&
	   (( now - ${AIRCRAFT_CACHE_TIME[$hex]:-0} < AIRCRAFT_CACHE_TTL )); then
		printf '%s\n' "${AIRCRAFT_CACHE[$hex]}"
		return
	fi

	local url="https://api.adsbdb.com/v0/aircraft/${hex}"
	local lookup_curl_args=(--silent --max-time 15)
	local response
	if ! response=$(curl "${lookup_curl_args[@]}" "$url"); then
		printf '\t\n'
		return
	fi

	local manufacturer owner
	manufacturer=$(jq -r 'try .response.aircraft.manufacturer catch ""' <<< "$response")
	owner=$(jq -r 'try .response.aircraft.registered_owner catch ""' <<< "$response")

	local result
	result=$(printf '%s\t%s' "$manufacturer" "$owner")

	if [[ -n "$manufacturer" || -n "$owner" ]]; then
		AIRCRAFT_CACHE[$hex]="$result"
		AIRCRAFT_CACHE_TIME[$hex]="$now"
	fi

	printf '%s\n' "$result"
}

# Looks up route (origin/destination) from FlightAware AeroAPI, by
# callsign, via GET /flights/{ident}. That endpoint can return several
# flights for a reused ident (past, current, future); prefer the one
# that's currently airborne (actual_off set, actual_on not yet set),
# falling back to the most recent entry otherwise.
# Cached by callsign so a loitering aircraft or a repeated flight number
# doesn't trigger a fresh (billed) query every poll.
#
# Prints 2 tab-separated fields: origin, destination
aeroapi_lookup() {

#turn off AERO API until I fugure out a good way to rate limit it.
	printf '\t\n'
	return

	local flight="$1"
	local now
	now=$(date +%s)

	if [[ -z "$flight" || "$flight" == "UNKNOWN" || -z "$AEROAPI_KEY" ]]; then
		printf '\t\n'
		return
	fi

	if [[ -n "${ROUTE_CACHE[$flight]:-}" ]] &&
	   (( now - ${ROUTE_CACHE_TIME[$flight]:-0} < ROUTE_CACHE_TTL )); then
		printf '%s\n' "${ROUTE_CACHE[$flight]}"
		return
	fi

	local url="${AEROAPI_BASE}/flights/${flight}"
	local response
	if ! response=$(curl --silent --max-time 15 --header "x-apikey: ${AEROAPI_KEY}" "$url"); then
		printf '\t\n'
		return
	fi

	local result
	result=$(jq -r '
		def pick:
		  ([.flights[]? | select((.actual_off != null) and (.actual_on == null))][0])
		  // (.flights[0] // null);
		pick as $f
		| if $f == null then "\t"
		  else [ ($f.origin.code_iata // $f.origin.code_icao // ""),
		         ($f.destination.code_iata // $f.destination.code_icao // "") ] | @tsv
		  end
	' <<< "$response" 2>/dev/null) || result=$'\t'

	# Only cache a real hit -- an empty result (bad ident, no key, rate
	# limited) shouldn't get pinned in the cache for the full TTL.
	if [[ "$result" != $'\t' ]]; then
		ROUTE_CACHE[$flight]="$result"
		ROUTE_CACHE_TIME[$flight]="$now"
	fi

	printf '%s\n' "$result"
}

if (( $# >= 1 )); then
  debugmode="$1"
else
  debugmode="0"
fi

while true; do
  if flights=$(fetch_flights); then
    while IFS=$'\t' read -r hex flight type distance altitude groundspeed; do
      [[ -n "$hex" ]] || continue
      typetext=$(aircraft_lookup "$type")

      IFS=$'\t' read -r manufacturer owner < <(adsbdb_lookup "$hex")
      IFS=$'\t' read -r origin destination < <(aeroapi_lookup "$flight")

      if [ -z "$typetext" ]; then
	    typetext="$manufacturer"
      fi

	  # check if the first parameter exists, and equal to 1. this is forcing the script to run in debug mode
	  if [[ "$debugmode" -eq 1 ]]; then
	    #debug output only.
		echo "$hex" "$flight" "$typetext" "$distance" "$altitude" "$groundspeed" "$owner" "$origin" "$destination"
	  else
	    #not in debug mode. send to board
   	    send_flight "$hex" "$flight" "$typetext" "$distance" "$altitude" "$groundspeed" "$owner" "$origin" "$destination" || \
        printf 'Unable to send flight %s to split-flap API\n' "$flight" >&2
	  fi
    done <<< "$flights"
  else
    printf 'Unable to retrieve ADS-B data from %s\n' "$ADSB_URL" >&2
  fi

  # check if the first parameter exists, and equal to 1. this is forcing the script to run in debug mode
  if [[ "$debugmode" -eq 1 ]]; then
    #break the loop.
    break
  fi

  sleep "$POLL_SECONDS"
done