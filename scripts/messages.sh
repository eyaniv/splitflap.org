#!/bin/bash

if [ "$#" -lt 2 ]; then
    echo "Usage: $0 <id> <message> [priority] [ttl]"
    echo "priority - immediate, high, normal, or low"
    echo "ttl - time until the message is removed in seconds"
    exit 1
fi

priority="normal"
ttl=""

if [ "$#" -gt 2 ]; then
	priority="$3"
fi

if [ "$#" -gt 3 ]; then
	ttl="$4"
fi

payload=$(jq -n \
    --arg id "$1" \
    --arg text "$2" \
    --arg priority "$priority" \
    --arg ttl "$ttl" \
    '{id: $id, text: $text, ttl: $ttl, priority: $priority}')

curl -s -o /dev/null -X POST http://localhost:3000/api/board/LCL836/messages \
  -H "Content-Type: application/json" \
  -H "X-API-Secret: my-secret" \
  -d "$payload"
