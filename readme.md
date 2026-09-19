<div align="center">

# splitflap.org

**Open-source split-flap display for any screen. Pair your phone. Control it wirelessly.**

[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![WebSocket](https://img.shields.io/badge/WebSocket-Real--time-2563eb?logo=socketdotio&logoColor=white)](#architecture)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-d4d4dc.svg)](https://github.com/MohdYahyaMahmodi/splitflap.org/pulls)
[![Self-Host](https://img.shields.io/badge/Self--Host-Ready-f97316?logo=docker&logoColor=white)](self-hosting.md)

<br />

![splitflap.org landing page](image.png)

<br />

![Board display example](board.png)

<br />

[**Live Site**](https://splitflap.org) · [**Self-Hosting Guide**](self-hosting.md) · [**Report Bug**](https://github.com/MohdYahyaMahmodi/splitflap.org/issues)

</div>

---

## What is this

A split-flap display that runs in a browser. The kind you used to see at train stations and airports. Open `board.html` on a TV, scan the QR code with your phone, and your phone becomes the wireless remote.

Four files. One Node.js server, a board page, a phone companion, and a standalone design tool. No build step, no frameworks, and a weather.gov integration for live forecast mode.

## Features

### Display Engine

Characters cycle through the spool sequentially (A, B, C... until they reach the target), the same way a real Solari board works. None of the random color-scramble nonsense that every other clone does.

The animation runs on a single `requestAnimationFrame` loop that processes a sorted queue of actions. A full 22x5 board transition schedules roughly 3,000 actions and they all run off one rAF callback per frame, not thousands of individual `setTimeout` calls.

Flap rotation uses the Web Animations API (`element.animate()`) so it runs on the compositor thread. The old approach of toggling CSS animations with `offsetHeight` reflow hacks is gone. Every cell also has `contain: layout style paint` so changing one flap's text doesn't trigger layout recalculation across the entire board.

Sound comes from the Web Audio API. If you drop a `click.wav` in the public folder it plays the real recording with slight pitch randomization (±0.2) per flap. No audio file? It synthesizes a click from a filtered noise burst. Concurrency is capped at 8 simultaneous audio nodes with a 25ms minimum interval so you don't blow out the audio thread.

### Phone Companion

Add messages with the + button. Each message gets its own card. They loop automatically with a configurable delay, or you can step through them manually.

The mini board preview at the top shows a grid that matches your exact row/column count. It renders real characters in each cell, shows color emoji cells in their actual color, and displays per-row counters like `R1: 15/22` with a red overflow warning if you go over.

Clock mode shows live time (12h with seconds), day of week, month/date, and year. Everything is centered on the board and flips every second.

Weather mode shows the next four forecast periods from weather.gov and, when active alerts exist, includes an alert slide in the rotation before flipping through the forecast details.  If an observation station is selected, a current
weather slide is provided as well.

Every visual parameter is adjustable from the companion in real time: flap dimensions, bezel radius, pinch depth, ridge styling, typography (family, size, weight, offsets), grid gap, board shadow, color gradients for top and bottom flaps, and 7 color emojis (🟥🟧🟨🟩🟦🟪⬜). The standalone `custom-board.html` lets you design flap aesthetics and export/import CSS without needing the server.

### Kiosk Board

Kiosk Board (referred to as primary board in the code) is a special board for always on displays. It is created automatically upon connection, and unlike the rest of the boards, does not expire after 24 hours.

If there is a kiosk Board, the first board.html connection will avoid showing the QR code connection screen, and will automatically connect to the kiosk board.

I will add an environment variable option to turn on or off the kiosk mode board, and change it's ID.

As of now, Kiosk Mode board is always created, and it's ID is LCL836

All other boards are created on demand, and will expire in 24 hours. according to the In addition to the multiple boards that are dynamically created with every phone connection, A special, local board is automatically created for kiosk presentations. if the server is launched with this mode, then the first board connection will avoid showing the QR code connection screen, and will automatically connect to the local, kiosk mode board.

### Security

Three layers, because the obvious question is "what if someone in the same room connects before you?"

**Layer 1: QR code with embedded secret.** The board generates a 32-character hex token via `crypto.randomBytes(16)` and bakes it into the QR URL: `companion.html#BOARDID.secret`. Scan it and you're paired instantly. The token is way too long for someone across the room to read off the screen.

**Layer 2: Approval gate for manual codes.** If someone types the 6-digit code without the secret (i.e. they can see the code but didn't scan the QR), the board shows a full-screen prompt: "Device wants to connect. Approve?" You press Enter or click Approve on the TV. Escape or Reject kills it.

**Layer 3: Auto-lock after pairing.** Once a companion connects, the board locks. All pairing info disappears from the screen. Any new pair attempts get rejected. The only way to unlock is to disconnect from the companion or kick them with the power button on the status bar. Both generate a fresh code and secret.

### Connection

If the TV loses connection (browser crash, WiFi drops, whatever), the server keeps the board record alive. The companion notices and retries every 3 seconds. When the TV comes back, it reconnects with the same code, the companion re-syncs settings and messages, and everything picks up where it left off.

Changing rows or columns from the companion fades the board out over 250ms, rebuilds the grid, and fades back in. No jarring flash.

The server pings all WebSocket connections every 30 seconds and kills anything that doesn't respond.

## Architecture

```
splitflap.org/
  server.js              Express + WebSocket server
  public/
    index.html           Landing page with demo board
    board.html           TV display (connects via WebSocket)
    companion.html       Phone remote (pairs via QR or manual code)
    custom-board.html    Standalone design tool (no server needed)
    click.wav            Optional recorded flap sound
```

### Server

Express serves static files. A `ws` WebSocket server handles pairing and message relay. Each board lives in a `Map`:

```
boardId → {
  boardWs,        // TV socket
  companionWs,    // Phone socket
  pendingWs,      // Socket waiting for approval
  secret,         // 32-char hex token for QR pairing
  settings,       // Last companion settings (kept for reconnect)
  messages,       // Last message text (kept for reconnect)
  mode,           // 'messages' | 'clock' | 'weather'
  locked,         // true once companion connects
  lastActive      // Timestamp, boards expire after 24h
}
```

Messages flow in two directions:

- **Companion → Server → Board**: `update_settings`, `update_messages`, `play_sequence`, `next_message`, `reset_board`, `set_mode`
- **Board → Server → Companion**: `board_state`, `companion_joined`, `companion_disconnected`
- **Pairing**: `register_board`, `pair`, `approve_pair`, `reject_pair`, `kick_companion`

### Board

The board is a CSS grid of flap cells. Each cell is built from nested divs: outer plate with border radius, bezel with gradient, a recessed hole cut with `clip-path: polygon()` (computed from the pinch/slope/corner-arc parameters), top and bottom flap halves, the falling flap (animated with `element.animate()`, rotating from 0 to -90 degrees on X), the dark split line between halves, and ridges at the bottom.

The animation engine is a sorted array of `{time, fn}` objects. Each frame, it walks the array and fires everything whose time has passed, then splices those entries out. When the array is empty, the flip is done.

### Companion

Vanilla HTML/CSS/JS, optimized for mobile. Talks to the board exclusively through the server. The companion and board never connect directly. State changes go as JSON over the socket and the board applies them.

The mini preview parses the current message, splits it into a grid matching the board dimensions, and re-renders on every keystroke.

### API

#### GET /api/health

Returns all active boards, their ID, number of messages recieved via API and if there is a companion connected. primary board is the kiosk mode One

Example:
```bash
curl -X GET http://online:3000/api/health \
  -H "X-API-Secret: my-secret"`
```

#### POST /api/board/:BOARDID/messages

Adds a message to the board. payload is json, { id: "msgid", text: "message text", ttl: optional, time to live in seconds, priority: optional, low/medium/high/immediate}

A medium priority message will have on average about 2x of low screen time
A high priority message will have on average about 2x of medium screen time
An immediate priority message will disrupt the rotation, show on screen for 2x of message show time, then revert to high priority and the rotation will continue

If a message with the same ID already exists in rotation, the new message will replace the current one

If the ttl is omitted, the message will rotate forever, or until deleted with DELETE API call

If priority is omitted, or the value do not match the permitted values above the message will be added with a normal priority. 

Priority field is NOT case sensitive

The text field can contain JSON encoded emojis or new lines.
For example, new line is \\n. Red and Green blocks are \\ud83d\\udfe9 and \\uD83D\\uDFE5

Example:
```bash
payload=$(jq -n \
    --arg id "welcome" \
    --arg text "Hello World" \
    --arg priority "low" \
    --arg ttl "600" \
    '{id: $id, text: $text, ttl: $ttl, priority: $priority}')

curl -s -o /dev/null -X POST http://localhost:3000/api/board/LCL836/messages \
  -H "Content-Type: application/json" \
  -H "X-API-Secret: my-secret" \
  -d "$payload"`
```

#### GET /api/board/:BOARDID/messages

Show all API messages currently in rotation

Example:
```bash
curl -s -X GET http://online:3000/api/board/LCL836/messages \
  -H "X-API-Secret: my-secret"`
```

#### DELETE /api/board/:BOARDID/messages/:MSGID

Remove the message with msgid from rotation

Example:
```bash
curl -s -X DELETE http://online:3000/api/board/LCL836/messages/welcome \
  -H "Content-Type: application/json" \
  -H "X-API-Secret: my-secret"`
```

#### POST /api/board/:BOARDID/next

Immediately skip to the next message in the rotation

Example:
```bash
curl -X POST http://online:3000/api/board/LCL836/next \
  -H "X-API-Secret: my-secret"`
```

#### GET /api/board/:BOARDID/play

Start the rotation (board launches in pause mode, this call will start playing the messages)

Example:
```bash
curl -X GET http://online:3000/api/board/LCL836/play \
  -H "X-API-Secret: my-secret"`
```

## Quick Start

```bash
git clone https://github.com/eyaniv/splitflap.org.git
cd splitflap.org
npm install
node server.js
```

Open `http://localhost:3000/board.html` on your TV.  
Open `http://localhost:3000/companion.html` on your phone.  
Scan the QR code.

See **[self-hosting.md](self-hosting.md)** for production deployment with HTTPS, systemd, Docker, and reverse proxy configs.

## Dependencies

| Package              | Version | Purpose                        |
| -------------------- | ------- | ------------------------------ |
| `express`            | ^4.x    | HTTP server, static files      |
| `ws`                 | ^8.x    | WebSocket server               |
| `helmet`             | ^7.x    | Security headers               |
| `express-rate-limit` | ^7.x    | Rate limiting (100 req/15 min) |

No frontend dependencies. No build tools. No transpilation.

## Browser Support

Works on Chrome/Edge 90+, Safari 15+ (iOS and macOS), Firefox 90+, Samsung Internet 15+, and most Chromium-based Smart TV browsers.

Needs: CSS `clip-path: polygon()`, Web Animations API, Web Audio API, WebSocket.

## Configuration

### Environment Variables

| Variable               | Default | Description                                                                  |
| ---------------------- | ------- | ---------------------------------------------------------------------------- |
| `PORT`                 | `3000`  | Server port                                                                  |
| `SPLITFLAP_API_SECRET` | none    | API secret key to include in the API request headers. Ignored if not defined |

### Board Defaults

The `S` object in `board.html` and `companion.html` holds all visual parameters. Everything is adjustable from the companion UI at runtime.

| Parameter      | Default | What it does                           |
| -------------- | ------- | -------------------------------------- |
| `cols`         | 22      | Grid columns                           |
| `rows`         | 6       | Grid rows                              |
| `animDuration` | 360ms   | Final flip duration                    |
| `fastSpeed`    | 25ms    | Speed per intermediate spool character |
| `animStagger`  | 40ms    | Wave delay between adjacent cells      |
| `msgDelay`     | 6000ms  | Pause between messages when looping    |
| `scale`        | 0.22    | Cell scale factor                      |

## Performance

Numbers for a 22x5 board (110 cells) doing a full transition:

- **~3,000 scheduled actions** (110 cells × ~27 avg spool steps × 3 actions each), all processed by one rAF loop
- **Zero querySelector calls during animation** thanks to the `cellCache[]` built at render time
- **8 max concurrent audio nodes**, 25ms throttle between clicks
- **No `filter: drop-shadow`** on animated elements (removing it from 220 cells eliminated 220 GPU filter compositing ops per frame)
- **Compositor-thread flips** via Web Animations API, no main-thread style recalc during animation

## License

MIT. See [LICENSE](LICENSE).

## Author

**Mohd Mahmodi**  
[mohdmahmodi.com](https://mohdmahmodi.com) · [@MohdMahmodi](https://x.com/MohdMahmodi)
