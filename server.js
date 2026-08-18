const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 65536 });

app.use(
  helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }),
);
app.use(express.json({ limit: "16kb" }));
app.use(
  "/api/",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);
app.use(express.static(path.join(__dirname, "public")));

const boards = new Map();

// ─────────────────────────────────────────────────────────────
// Home automation API
// ─────────────────────────────────────────────────────────────

// Set this environment variable to protect the REST API:
//
//   export SPLITFLAP_API_SECRET="your-secret"
//
// If no secret is configured, the API is accessible without
// authentication. This preserves the original local-only behavior.
const API_SECRET = process.env.SPLITFLAP_API_SECRET || "";

// Map of:
//   boardId -> Map(messageId -> { id, text })
//
// Each board therefore has its own independent set of
// persistent home-automation messages.
const apiMessages = new Map();

// ─────────────────────────────────────────────────────────────

const BOARD_TTL = 24 * 60 * 60 * 1000;
const ID_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const DEFAULT_WEATHER_POINT = {
  latitude: 43.740058,
  longitude: -116.388178,
};

const WEATHER_CACHE_MS = 10 * 60 * 1000;
const WEATHER_ALERT_CACHE_MS = 60 * 1000;
const WEATHER_POINT_CACHE_MS = 60 * 60 * 1000;
const WEATHER_FETCH_TIMEOUT_MS = 8 * 1000;
const WEATHER_PERIOD_COUNT = 4;
const OBSERVATION_STATION_COUNT = 5;
const FIRST_BOARD_ID = "LCL836";
const PRIMARY_STATE_FILE = path.join(__dirname, "primary-board.json");

function loadPrimaryState() {
  try {
    if (!fs.existsSync(PRIMARY_STATE_FILE)) return null;
    const state = JSON.parse(fs.readFileSync(PRIMARY_STATE_FILE, "utf8"));

    if (
      !state ||
      typeof state.boardId !== "string" ||
      state.boardId !== FIRST_BOARD_ID ||
      typeof state.secret !== "string" ||
      !/^[a-f0-9]{32}$/i.test(state.secret)
    ) {
      return null;
    }

    return {
      boardId: FIRST_BOARD_ID,
      secret: state.secret.toLowerCase(),
      settings: state.settings || null,
      baseMessages:
        typeof state.baseMessages === "string"
          ? state.baseMessages
          : "",
      mode:
        typeof state.mode === "string"
          ? state.mode
          : "messages",
      weatherPoint:
        state.weatherPoint &&
        Number.isFinite(Number(state.weatherPoint.latitude)) &&
        Number.isFinite(Number(state.weatherPoint.longitude))
          ? {
              latitude: Number(state.weatherPoint.latitude),
              longitude: Number(state.weatherPoint.longitude),
            }
          : DEFAULT_WEATHER_POINT,
      weatherStation:
        typeof state.weatherStation === "string"
          ? state.weatherStation
          : "",
    };
  } catch (err) {
    console.error("Unable to load primary-board.json:", err.message);
    return null;
  }
}

function savePrimaryState(board) {
  if (!board?.primary) return;

  const state = {
    boardId: FIRST_BOARD_ID,
    secret: board.secret,
    settings: board.settings || null,
    baseMessages:
      typeof board.baseMessages === "string"
        ? board.baseMessages
        : "",
    mode: board.mode || "messages",
    weatherPoint: board.weatherPoint || DEFAULT_WEATHER_POINT,
    weatherStation: board.weatherStation || "",
  };

  try {
    const tmp = `${PRIMARY_STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmp, PRIMARY_STATE_FILE);
  } catch (err) {
    console.error("Unable to save primary-board.json:", err.message);
  }
}

const weatherCache = new Map();
const weatherAlertCache = new Map();
const weatherPointCache = new Map();

function genBoardId() {
  let id;

  if (!boards.has(FIRST_BOARD_ID)) {
    return FIRST_BOARD_ID;
  }

  do {
    id = "";
    const bytes = crypto.randomBytes(6);

    for (let i = 0; i < 6; i++) {
      id += ID_CHARS[bytes[i] % ID_CHARS.length];
    }
  } while (boards.has(id));

  return id;
}

function genSecret() {
  return crypto.randomBytes(16).toString("hex"); // 32 hex chars
}

// ─────────────────────────────────────────────────────────────
// Home automation API helpers
// ─────────────────────────────────────────────────────────────

function normalizeBoardId(rawBoardId) {
  if (typeof rawBoardId !== "string") return "";

  return rawBoardId
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
}

function apiAuthorized(req) {
  // If no API secret is configured, allow requests.
  if (!API_SECRET) return true;

  return req.get("X-API-Secret") === API_SECRET;
}

function getApiMessages(boardId) {
  if (!apiMessages.has(boardId)) {
    apiMessages.set(boardId, new Map());
  }

  return apiMessages.get(boardId);
}

function getApiMessageList(boardId) {
  return Array.from(getApiMessages(boardId).values());
}

function apiMessageText(boardId) {
  return getApiMessageList(boardId)
    .map((message) => message.text)
    .join("\n---\n");
}

function combineMessages(baseMessages, boardId) {
  const base =
    typeof baseMessages === "string" ? baseMessages.trim() : "";

  const api = apiMessageText(boardId);

  if (base && api) {
    return `${base}\n---\n${api}`;
  }

  if (api) {
    return api;
  }

  return base;
}

function getApiBoard(boardId) {
  const id = normalizeBoardId(boardId);

  if (!id) {
    return {
      id,
      board: null,
      error: "Invalid board ID",
      status: 400,
    };
  }

  const board = boards.get(id);

  if (!board) {
    return {
      id,
      board: null,
      error: "Board not found",
      status: 404,
    };
  }

  if (!board.boardWs || board.boardWs.readyState !== 1) {
    return {
      id,
      board,
      error: "Board is offline",
      status: 503,
    };
  }

  return {
    id,
    board,
    error: null,
    status: 200,
  };
}

function sendApiMessages(board, boardId) {
  if (!board || !board.boardWs || board.boardWs.readyState !== 1) {
    return false;
  }

  const id = boardId || board.boardId;

  if (!id) return false;

  board.messages = combineMessages(board.baseMessages, id);

  safeSend(board.boardWs, {
    type: "update_messages",
    messages: board.messages,
  });

  return true;
}

function moveApiMessages(oldBoardId, newBoardId) {
  if (!oldBoardId || !newBoardId || oldBoardId === newBoardId) {
    return;
  }

  const messages = apiMessages.get(oldBoardId);

  if (messages) {
    apiMessages.delete(oldBoardId);
    apiMessages.set(newBoardId, messages);
  }
}

// ─────────────────────────────────────────────────────────────
// Weather
// ─────────────────────────────────────────────────────────────

async function fetchWeatherGovJson(url) {
  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    WEATHER_FETCH_TIMEOUT_MS,
  );

  timeout.unref?.();

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/geo+json, application/json",
        "User-Agent": "splitflap.org weather proxy",
      },
    });

    if (!res.ok) {
      throw new Error(`Weather API ${res.status}`);
    }

    return await res.json();
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(
        `Weather API timeout after ${WEATHER_FETCH_TIMEOUT_MS}ms`,
      );
    }

    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeWeatherPoint(rawLatitude, rawLongitude) {
  if (rawLatitude === undefined || rawLongitude === undefined) {
    return null;
  }

  const latitude = Number(rawLatitude);
  const longitude = Number(rawLongitude);

  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return null;
  }

  return {
    latitude: Number(latitude.toFixed(4)),
    longitude: Number(longitude.toFixed(4)),
  };
}

function weatherPointKey(point) {
  return `${point.latitude},${point.longitude}`;
}

function normalizeWeatherStation(rawStation) {
  if (typeof rawStation !== "string") return "";

  return rawStation
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 12);
}

function weatherDataKey(point, stationId) {
  return `${weatherPointKey(point)}:${stationId || ""}`;
}

function getStationDistanceMiles(feature) {
  const distance = feature?.properties?.distance;
  const value = Number(distance?.value);

  if (!Number.isFinite(value)) return null;

  const unitCode = String(distance?.unitCode || "").toLowerCase();

  if (unitCode.includes("km")) {
    return Number((value * 0.621371).toFixed(1));
  }

  if (unitCode.includes(":m") || unitCode.endsWith("/m")) {
    return Number((value / 1609.344).toFixed(1));
  }

  return Number((value * 0.621371).toFixed(1));
}

function clearWeatherPointCaches(point) {
  const key = weatherPointKey(point);

  for (const cacheKey of weatherCache.keys()) {
    if (
      cacheKey === key ||
      cacheKey.startsWith(`${key}:`)
    ) {
      weatherCache.delete(cacheKey);
    }
  }

  weatherAlertCache.delete(key);
  weatherPointCache.delete(key);
}

function convertTemperature(value, unitCode) {
  if (typeof value !== "number") return null;

  if (String(unitCode).toLowerCase().includes("degc")) {
    return Math.round((value * 9) / 5 + 32);
  }

  return Math.round(value);
}

function convertWindSpeed(value, unitCode) {
  if (typeof value !== "number") return null;

  const unit = String(unitCode).toLowerCase();

  if (unit.includes("m_s-1")) {
    return Math.round(value * 2.23694);
  }

  if (unit.includes("km_h-1")) {
    return Math.round(value * 0.621371);
  }

  return Math.round(value);
}

function convertPressure(value, unitCode) {
  if (typeof value !== "number") return null;

  if (String(unitCode).toLowerCase().includes("pa")) {
    return Number((value / 3386.389).toFixed(2));
  }

  return Number(value.toFixed(2));
}

function buildCurrentObservation(observation, station) {
  const props = observation?.properties || {};
  const temperature = props.temperature || {};
  const windSpeed = props.windSpeed || {};
  const windGust = props.windGust || {};
  const pressure = props.barometricPressure || {};
  const humidity = props.relativeHumidity || {};

  return {
    station: station.id,
    stationName: station.name || station.id,
    stationDistanceMiles: station.distanceMiles,
    text: props.textDescription || "",
    temperature: convertTemperature(
      temperature.value,
      temperature.unitCode,
    ),
    temperatureUnit: "F",
    windDirection:
      typeof props.windDirection?.value === "number"
        ? Math.round(props.windDirection.value)
        : null,
    windSpeed: convertWindSpeed(
      windSpeed.value,
      windSpeed.unitCode,
    ),
    windGust: convertWindSpeed(
      windGust.value,
      windGust.unitCode,
    ),
    pressure: convertPressure(
      pressure.value,
      pressure.unitCode,
    ),
    humidity:
      typeof humidity.value === "number"
        ? Math.round(humidity.value)
        : null,
    timestamp: props.timestamp || null,
  };
}

async function getWeatherPointData(weatherPoint) {
  const key = weatherPointKey(weatherPoint);
  const cached = weatherPointCache.get(key);

  if (cached?.data && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const { latitude, longitude } = weatherPoint;

  const pointResponse = await fetchWeatherGovJson(
    `https://api.weather.gov/points/${latitude},${longitude}`,
  );

  const forecastBaseUrl = pointResponse?.properties?.forecast;

  if (!forecastBaseUrl) {
    throw new Error("Forecast URL missing");
  }

  const stationsUrl =
    pointResponse?.properties?.observationStations;

  if (!stationsUrl) {
    throw new Error("Observation stations URL missing");
  }

  const stationsResponse =
    await fetchWeatherGovJson(stationsUrl);

  // get the first 5 stations with valid IDs
  const observationStations = (stationsResponse?.features || [])
    .map((feature) => ({
      id: normalizeWeatherStation(
        feature.properties?.stationIdentifier,
      ),
      name: feature.properties?.name || "",
      distanceMiles: getStationDistanceMiles(feature),
    }))
    .filter((station) => station.id)
    .slice(0, OBSERVATION_STATION_COUNT);

  const pointData = {
    latitude,
    longitude,
    gridId: pointResponse?.properties?.gridId || "",
    gridX: pointResponse?.properties?.gridX ?? null,
    gridY: pointResponse?.properties?.gridY ?? null,
    forecastUrl: `${forecastBaseUrl}?units=us`,
    observationStations,
  };

  weatherPointCache.set(key, {
    data: pointData,
    expiresAt: Date.now() + WEATHER_POINT_CACHE_MS,
  });

  return pointData;
}

async function getCurrentWeather(station) {
  if (!station?.id) return null;

  const observation = await fetchWeatherGovJson(
    `https://api.weather.gov/stations/${encodeURIComponent(
      station.id,
    )}/observations/latest`,
  );

  return buildCurrentObservation(observation, station);
}

async function getWeatherAlerts(point) {
  const now = Date.now();
  const key = weatherPointKey(point);
  const cached = weatherAlertCache.get(key);

  if (cached?.data && cached.expiresAt > now) {
    return cached.data;
  }

  const { latitude, longitude } = point;

  const alertsResult = await fetchWeatherGovJson(
    `https://api.weather.gov/alerts/active?status=actual,exercise,system,test,draft&message_type=alert,update&point=${latitude}%2C${longitude}`,
  );

  const alerts = (alertsResult?.features || []).map(
    (feature) => ({
      id: feature.id || "",
      area: feature.properties?.areaDesc || "",
      title: feature.properties?.headline || "",
      severity: feature.properties?.severity || "",
      certainty: feature.properties?.certainty || "",
      urgency: feature.properties?.urgency || "",
      event: feature.properties?.event || "",
      effective: feature.properties?.effective || null,
      expires: feature.properties?.expires || null,
      description: feature.properties?.description || "",
      instruction: feature.properties?.instruction || "",
    }),
  );

  weatherAlertCache.set(key, {
    data: alerts,
    expiresAt: now + WEATHER_ALERT_CACHE_MS,
  });

  return alerts;
}

async function getWeatherData(point, requestedStationId) {
  const now = Date.now();

  const stationId =
    normalizeWeatherStation(requestedStationId);

  const key = weatherDataKey(point, stationId);
  const cached = weatherCache.get(key);

  if (cached?.data && cached.expiresAt > now) {
    const alerts = await getWeatherAlerts(point);
    cached.data.alerts = alerts;
    return cached.data;
  }

  const pointData = await getWeatherPointData(point);
  const { latitude, longitude } = pointData;

  const selectedStation =
    pointData.observationStations.find(
      (station) => station.id === stationId,
    );

  const alerts = await getWeatherAlerts(point);

  const forecast = await fetchWeatherGovJson(
    pointData.forecastUrl,
  );

  const periods = (forecast?.properties?.periods || [])
    .slice(0, WEATHER_PERIOD_COUNT)
    .map((period) => ({
      name: period.name || "Now",
      isDaytime: !!period.isDaytime,
      temperature: period.temperature ?? null,
      temperatureUnit: period.temperatureUnit || "F",
      shortForecast: period.shortForecast || "",
      windSpeed: period.windSpeed || "",
      windDirection: period.windDirection || "",
      probabilityOfPrecipitation:
        period?.probabilityOfPrecipitation?.value ?? null,
      startTime: period.startTime || null,
      endTime: period.endTime || null,
    }));

  if (!periods.length) {
    throw new Error("Forecast period missing");
  }

  const data = {
    fetchedAt: new Date().toISOString(),

    location: {
      latitude,
      longitude,
      gridId: pointData.gridId,
      gridX: pointData.gridX,
      gridY: pointData.gridY,
    },

    observationStations: pointData.observationStations,

    weatherStation: selectedStation?.id || "",

    updatedAt:
      forecast?.properties?.updateTime ||
      forecast?.properties?.generatedAt ||
      null,

    alerts,

    current: selectedStation
      ? await getCurrentWeather(selectedStation).catch(
          () => null,
        )
      : null,

    periods,
  };

  weatherCache.set(key, {
    data,
    expiresAt: now + WEATHER_CACHE_MS,
  });

  return data;
}

// ─────────────────────────────────────────────────────────────
// Board cleanup
// ─────────────────────────────────────────────────────────────

setInterval(
  () => {
    const now = Date.now();

    for (const [id, b] of boards) {
      if (id != FIRST_BOARD_ID && (now - b.lastActive > BOARD_TTL)) {
        try {
          if (b.boardWs) b.boardWs.close();
        } catch (_) {}

        try {
          if (b.companionWs) b.companionWs.close();
        } catch (_) {}

        boards.delete(id);

        // The board is gone, so its API message state is no longer
        // useful either.
        apiMessages.delete(id);
      }
    }
  },
  5 * 60 * 1000,
);

// ─────────────────────────────────────────────────────────────
// Health
// ─────────────────────────────────────────────────────────────

app.get("/api/health", (_, res) => {
  const boardList = Array.from(boards.entries()).map(
    ([boardId, board]) => ({
      boardId,
      primary: !!board.primary,
      connected:
        !!board.boardWs &&
        board.boardWs.readyState === 1,
      companionConnected:
        !!board.companionWs &&
        board.companionWs.readyState === 1,
      apiMessages: getApiMessageList(boardId).length,
    }),
  );

  res.json({
    ok: true,
    boards: boardList,
  });
});

// ─────────────────────────────────────────────────────────────
// Home automation REST API
// ─────────────────────────────────────────────────────────────

// Immediate message.
//
// Does NOT change the message rotation.
//
// POST /api/board/ABC123/message
//
// {
//   "text": "DINNER IS READY"
// }
app.post("/api/board/:boardId/message", (req, res) => {
  if (!apiAuthorized(req)) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized",
    });
  }

  const result = getApiBoard(req.params.boardId);

  if (result.error) {
    return res.status(result.status).json({
      ok: false,
      error: result.error,
      boardId: result.id || undefined,
    });
  }

  if (
    typeof req.body?.text !== "string" ||
    !req.body.text.trim()
  ) {
    return res.status(400).json({
      ok: false,
      error: "text is required",
    });
  }

  const text = req.body.text.trim().slice(0, 1000);

  safeSend(result.board.boardWs, {
    type: "flip_message",
    text,
  });

  result.board.lastActive = Date.now();

  res.json({
    ok: true,
    boardId: result.id,
    text,
  });
});

// Start Message rotation
//
// GET /api/board/ABC123/play
//
app.get("/api/board/:boardId/play", (req, res) => {
  if (!apiAuthorized(req)) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized",
    });
  }

  const result = getApiBoard(req.params.boardId);

  if (result.error) {
    return res.status(result.status).json({
      ok: false,
      error: result.error,
      boardId: result.id || undefined,
    });
  }

  safeSend(result.board.boardWs, {
    type: "play_sequence",
  });

  result.board.lastActive = Date.now();

  res.json({
    ok: true,
    boardId: result.id,
  });
});

// Get persistent API-managed messages for a board.
//
// GET /api/board/ABC123/messages
app.get("/api/board/:boardId/messages", (req, res) => {
  if (!apiAuthorized(req)) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized",
    });
  }

  const id = normalizeBoardId(req.params.boardId);

  if (!id) {
    return res.status(400).json({
      ok: false,
      error: "Invalid board ID",
    });
  }

  if (!boards.has(id)) {
    return res.status(404).json({
      ok: false,
      error: "Board not found",
      boardId: id,
    });
  }

  res.json({
    ok: true,
    boardId: id,
    messages: getApiMessageList(id),
  });
});

// Add or replace a persistent automation message.
//
// POST /api/board/ABC123/messages
//
// {
//   "id": "garage",
//   "text": "GARAGE DOOR OPEN"
// }
app.post("/api/board/:boardId/messages", (req, res) => {
  if (!apiAuthorized(req)) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized",
    });
  }

  const result = getApiBoard(req.params.boardId);

  if (result.error) {
    return res.status(result.status).json({
      ok: false,
      error: result.error,
      boardId: result.id || undefined,
    });
  }

  const id =
    typeof req.body?.id === "string"
      ? req.body.id.trim()
      : "";

  const text =
    typeof req.body?.text === "string"
      ? req.body.text.trim()
      : "";

  if (!id || !text) {
    return res.status(400).json({
      ok: false,
      error: "id and text are required",
    });
  }

  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    return res.status(400).json({
      ok: false,
      error: "Invalid message id",
    });
  }

  const messages = getApiMessages(result.id);

  messages.set(id, {
    id,
    text: text.slice(0, 1000),
  });

  sendApiMessages(result.board, result.id);

  result.board.lastActive = Date.now();
  savePrimaryState(result.board);

  res.json({
    ok: true,
    boardId: result.id,
    messages: getApiMessageList(result.id),
  });
});

// Remove a persistent automation message.
//
// DELETE /api/board/ABC123/messages/garage
app.delete(
  "/api/board/:boardId/messages/:messageId",
  (req, res) => {
    if (!apiAuthorized(req)) {
      return res.status(401).json({
        ok: false,
        error: "Unauthorized",
      });
    }

    const boardId = normalizeBoardId(req.params.boardId);

    if (!boardId) {
      return res.status(400).json({
        ok: false,
        error: "Invalid board ID",
      });
    }

    if (!boards.has(boardId)) {
      return res.status(404).json({
        ok: false,
        error: "Board not found",
        boardId,
      });
    }

    const messages = getApiMessages(boardId);
    const messageId = req.params.messageId;

    if (!messages.has(messageId)) {
      return res.status(404).json({
        ok: false,
        error: "Message not found",
        boardId,
        messageId,
      });
    }

    messages.delete(messageId);

    const board = boards.get(boardId);

    if (
      board?.boardWs &&
      board.boardWs.readyState === 1
    ) {
      sendApiMessages(board, boardId);
      board.lastActive = Date.now();
      savePrimaryState(board);
    }

    res.json({
      ok: true,
      boardId,
      messages: getApiMessageList(boardId),
    });
  },
);

// Immediately advance to the next message.
//
// POST /api/board/ABC123/next
app.post("/api/board/:boardId/next", (req, res) => {
  if (!apiAuthorized(req)) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized",
    });
  }

  const result = getApiBoard(req.params.boardId);

  if (result.error) {
    return res.status(result.status).json({
      ok: false,
      error: result.error,
      boardId: result.id || undefined,
    });
  }

  safeSend(result.board.boardWs, {
    type: "next_message",
  });

  result.board.lastActive = Date.now();

  res.json({
    ok: true,
    boardId: result.id,
  });
});

// ─────────────────────────────────────────────────────────────
// Weather API
// ─────────────────────────────────────────────────────────────

app.get("/api/weather", async (req, res) => {
  try {
    const point = normalizeWeatherPoint(
      req.query.lat,
      req.query.lon,
    );

    if (!point) {
      res.status(400).json({
        ok: false,
        error: "Invalid weather coordinates",
      });

      return;
    }

    if (req.query.refresh === "1") {
      clearWeatherPointCaches(point);
    }

    const data = await getWeatherData(
      point,
      req.query.station,
    );

    res.json({
      ok: true,
      ...data,
    });
  } catch (err) {
    res.status(502).json({
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : "Weather unavailable",
    });
  }
});

app.get("/api/weather/point", async (req, res) => {
  try {
    const point = normalizeWeatherPoint(
      req.query.lat,
      req.query.lon,
    );

    if (!point) {
      res.status(400).json({
        ok: false,
        error: "Invalid weather coordinates",
      });

      return;
    }

    if (req.query.refresh === "1") {
      clearWeatherPointCaches(point);
    }

    const pointData =
      await getWeatherPointData(point);

    res.json({
      ok: true,

      location: {
        latitude: pointData.latitude,
        longitude: pointData.longitude,
        gridId: pointData.gridId,
        gridX: pointData.gridX,
        gridY: pointData.gridY,
      },

      observationStations:
        pointData.observationStations,
    });
  } catch (err) {
    res.status(502).json({
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : "Weather point unavailable",
    });
  }
});

// ─────────────────────────────────────────────────────────────
// WebSockets
// ─────────────────────────────────────────────────────────────

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.msgCount = 0;
  ws.msgWindow = Date.now();
  ws.role = null;
  ws.boardId = null;

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw) => {
    const now = Date.now();

    if (now - ws.msgWindow > 60000) {
      ws.msgCount = 0;
      ws.msgWindow = now;
    }

    if (++ws.msgCount > 120) {
      safeSend(ws, {
        type: "error",
        message: "Rate limited",
      });

      return;
    }

    let msg;

    try {
      const str = raw.toString();

      if (str.length > 65536) return;

      msg = JSON.parse(str);
    } catch (_) {
      return;
    }

    if (
      !msg ||
      typeof msg.type !== "string" ||
      msg.type.length > 64
    ) {
      return;
    }

    handleMsg(ws, msg);
  });

  ws.on("close", () => {
    if (!ws.boardId) return;

    const b = boards.get(ws.boardId);

    if (!b) return;

    if (b.boardWs === ws) {
      b.boardWs = null;

      safeSend(b.companionWs, {
        type: "board_disconnected",
      });

      // Primary board remains registered even while its display
      // WebSocket is temporarily disconnected.
      if (b.primary) {
        b.lastActive = Date.now();
        savePrimaryState(b);
      }
    }

    if (b.companionWs === ws) {
      b.companionWs = null;

      safeSend(b.boardWs, {
        type: "companion_disconnected",
      });
    }

    // Clear pending if the pending companion disconnected
    if (b.pendingWs === ws) {
      b.pendingWs = null;
    }
  });

  ws.on("error", () => {});
});

function safeSend(ws, obj) {
  if (ws && ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(obj));
    } catch (_) {}
  }
}

function handleMsg(ws, msg) {
  switch (msg.type) {
    // ── Board registers ──

    case "register_board": {
      const boardId = genBoardId();
      const isPrimary = boardId === FIRST_BOARD_ID;
      const persisted = isPrimary ? loadPrimaryState() : null;
      const secret = persisted?.secret || genSecret();

      boards.set(boardId, {
        boardId,
        primary: isPrimary,
        persistent: isPrimary,
        boardWs: ws,
        companionWs: null,
        pendingWs: null,
        secret,
        settings: persisted?.settings || null,
        messages: null,

        // The companion's messages are kept separately so API
        // messages can be added without destroying them.
        baseMessages: persisted?.baseMessages || "",

        mode: persisted?.mode || "messages",

        weatherPoint: persisted?.weatherPoint || DEFAULT_WEATHER_POINT,
        weatherStation: persisted?.weatherStation || "",

        locked: false,

        createdAt: Date.now(),
        lastActive: Date.now(),
      });

      if (isPrimary) {
        savePrimaryState(boards.get(boardId));
      }

      ws.boardId = boardId;
      ws.role = "board";

      safeSend(ws, {
        type: "registered",
        boardId,
        secret,
        primary: isPrimary,
        autoConnected: isPrimary,
      });

      console.log(`Board created: ${boardId}`);

      break;
    }

    // ── Companion requests pairing ──

    case "pair": {
      const id =
        typeof msg.boardId === "string"
          ? msg.boardId
              .toUpperCase()
              .replace(/[^A-Z0-9]/g, "")
              .slice(0, 6)
          : "";

      const secret =
        typeof msg.secret === "string"
          ? msg.secret
              .replace(/[^a-f0-9]/gi, "")
              .slice(0, 32)
              .toLowerCase()
          : "";

      if (id.length !== 6) {
        safeSend(ws, {
          type: "error",
          message: "Invalid code",
        });

        return;
      }

      const b = boards.get(id);

      if (!b) {
        safeSend(ws, {
          type: "error",
          message: "Board not found",
        });

        return;
      }

      if (!b.boardWs || b.boardWs.readyState !== 1) {
        safeSend(ws, {
          type: "error",
          message: "Board is offline",
        });

        return;
      }

      // If board is locked (already has a companion), reject
      if (
        b.locked &&
        b.companionWs &&
        b.companionWs.readyState === 1
      ) {
        safeSend(ws, {
          type: "error",
          message:
            "Board is locked. Disconnect current companion first.",
        });

        return;
      }

      // Check if secret matches (QR code path) → auto-approve
      if (
        secret.length === 32 &&
        secret === b.secret
      ) {
        completePairing(b, ws, id);
        return;
      }

      // Manual code path → require board-side approval

      if (b.pendingWs) {
        safeSend(b.pendingWs, {
          type: "error",
          message:
            "Another device is waiting for approval",
        });
      }

      b.pendingWs = ws;
      ws.boardId = id;

      safeSend(ws, {
        type: "waiting_approval",
        message:
          "Waiting for TV to approve...",
      });

      safeSend(b.boardWs, {
        type: "pair_request",
      });

      console.log(`Pair request pending: ${id}`);

      break;
    }

    // ── Board approves pending companion ──

    case "approve_pair": {
      if (
        ws.role !== "board" ||
        !ws.boardId
      ) {
        return;
      }

      const b = boards.get(ws.boardId);

      if (!b || !b.pendingWs) {
        return;
      }

      completePairing(
        b,
        b.pendingWs,
        ws.boardId,
      );

      b.pendingWs = null;

      break;
    }

    // ── Board rejects pending companion ──

    case "reject_pair": {
      if (
        ws.role !== "board" ||
        !ws.boardId
      ) {
        return;
      }

      const b = boards.get(ws.boardId);

      if (!b || !b.pendingWs) {
        return;
      }

      safeSend(b.pendingWs, {
        type: "error",
        message:
          "Connection rejected by TV",
      });

      b.pendingWs.boardId = null;
      b.pendingWs = null;

      safeSend(ws, {
        type: "pair_rejected",
      });

      console.log(
        `Pair rejected: ${ws.boardId}`,
      );

      break;
    }

    // ── Companion disconnects cleanly ──

    case "companion_disconnect": {
      if (
        ws.role !== "companion" ||
        !ws.boardId
      ) {
        return;
      }

      const oldBoardId = ws.boardId;
      const b = boards.get(oldBoardId);

      if (!b) return;

      b.companionWs = null;
      b.locked = false;
      b.lastActive = Date.now();

      if (b.primary) {
        safeSend(b.boardWs, {
          type: "companion_disconnected",
          boardId: b.boardId,
          primary: true,
          autoConnected: true,
        });

        ws.boardId = null;
        ws.role = null;

        safeSend(ws, {
          type: "disconnected",
        });

        savePrimaryState(b);
        break;
      }

      // Generate new code+secret for next pairing
      boards.delete(oldBoardId);

      const newId = genBoardId();
      const newSecret = genSecret();

      // Keep API messages associated with the physical
      // board even though the pairing ID changes.
      moveApiMessages(oldBoardId, newId);

      b.boardId = newId;

      boards.set(newId, {
        ...b,
        boardId: newId,
        companionWs: null,
        pendingWs: null,
        secret: newSecret,
        locked: false,
        lastActive: Date.now(),
      });

      if (b.boardWs) {
        b.boardWs.boardId = newId;
      }

      safeSend(b.boardWs, {
        type:
          "companion_disconnected_new_code",
        boardId: newId,
        secret: newSecret,
      });

      ws.boardId = null;
      ws.role = null;

      safeSend(ws, {
        type: "disconnected",
      });

      break;
    }

    // ── Board kicks companion ──

    case "kick_companion": {
      if (
        ws.role !== "board" ||
        !ws.boardId
      ) {
        return;
      }

      const oldBoardId = ws.boardId;
      const b = boards.get(oldBoardId);

      if (!b) return;

      if (b.companionWs) {
        safeSend(b.companionWs, {
          type: "kicked",
        });

        b.companionWs.boardId = null;
        b.companionWs.role = null;
        b.companionWs = null;
      }

      b.locked = false;

      if (b.primary) {
        b.lastActive = Date.now();

        safeSend(ws, {
          type: "primary_ready",
          boardId: b.boardId,
          primary: true,
          autoConnected: true,
        });

        savePrimaryState(b);
        break;
      }

      // New code+secret
      boards.delete(oldBoardId);

      const newId = genBoardId();
      const newSecret = genSecret();

      // Keep API messages associated with the physical
      // board even though the pairing ID changes.
      moveApiMessages(oldBoardId, newId);

      b.boardId = newId;

      boards.set(newId, {
        ...b,
        boardId: newId,
        companionWs: null,
        pendingWs: null,
        secret: newSecret,
        locked: false,
        lastActive: Date.now(),
      });

      ws.boardId = newId;

      safeSend(ws, {
        type: "new_code",
        boardId: newId,
        secret: newSecret,
      });

      console.log(
        `Board kicked, new code: ${newId}`,
      );

      break;
    }

    // ── Board reconnects ──

    case "reconnect_board": {
      const id =
        typeof msg.boardId === "string"
          ? msg.boardId
              .toUpperCase()
              .replace(/[^A-Z0-9]/g, "")
              .slice(0, 6)
          : "";

      const b = boards.get(id);

      if (!b) {
        safeSend(ws, {
          type: "error",
          message: "Board expired",
        });

        return;
      }

      b.boardWs = ws;
      b.boardId = id;
      b.lastActive = Date.now();

      // Make sure the board gets the combined message list
      // after reconnecting.
      b.messages = combineMessages(
        b.baseMessages,
        id,
      );

      ws.boardId = id;
      ws.role = "board";

      safeSend(ws, {
        type: "reconnected",
        boardId: id,
        secret: b.secret,
        settings: b.settings,
        messages: b.messages,
        mode: b.mode,
        weatherPoint: b.weatherPoint,
        weatherStation: b.weatherStation,
        locked: b.locked,
        primary: !!b.primary,
        autoConnected: !!b.primary,
      });

      if (b.primary) {
        savePrimaryState(b);
      }

      safeSend(b.companionWs, {
        type: "board_reconnected",
      });

      console.log(
        `Board reconnected: ${id}`,
      );

      break;
    }

    // ── Forward companion → board commands ──

    case "update_settings":
    case "update_messages":
    case "play_sequence":
    case "next_message":
    case "reset_board":
    case "flip_message":
    case "set_mode": {
      if (
        ws.role !== "companion" ||
        !ws.boardId
      ) {
        return;
      }

      const b = boards.get(ws.boardId);

      if (!b) return;

      b.lastActive = Date.now();

      if (
        msg.type === "update_settings" &&
        msg.settings &&
        typeof msg.settings === "object"
      ) {
        b.settings = msg.settings;
        savePrimaryState(b);
      }

      if (
        msg.type === "update_messages" &&
        typeof msg.messages === "string"
      ) {
        // Keep the companion's messages separate from the
        // home automation messages.
        b.baseMessages =
          msg.messages.slice(0, 10000);

        // Send the combined list to the board.
        b.messages = combineMessages(
          b.baseMessages,
          ws.boardId,
        );

        msg.messages = b.messages;
        savePrimaryState(b);
      }

      if (
        msg.type === "set_mode" &&
        typeof msg.mode === "string"
      ) {
        b.mode = msg.mode;

        if (
          msg.weatherPoint &&
          typeof msg.weatherPoint === "object"
        ) {
          const point =
            normalizeWeatherPoint(
              msg.weatherPoint.latitude,
              msg.weatherPoint.longitude,
            );

          if (point) {
            b.weatherPoint = point;
            msg.weatherPoint = point;
          } else {
            delete msg.weatherPoint;
          }
        }

        if (
          typeof msg.weatherStation ===
          "string"
        ) {
          b.weatherStation =
            normalizeWeatherStation(
              msg.weatherStation,
            );
        }

        msg.weatherStation =
          b.weatherStation;
      }

      savePrimaryState(b);
      safeSend(b.boardWs, msg);

      break;
    }

    case "board_state": {
      if (
        ws.role !== "board" ||
        !ws.boardId
      ) {
        return;
      }

      const b = boards.get(ws.boardId);

      if (!b) return;

      b.lastActive = Date.now();

      safeSend(b.companionWs, msg);

      break;
    }
  }
}

function completePairing(
  b,
  companionWs,
  boardId,
) {
  // Replace existing companion if any
  if (
    b.companionWs &&
    b.companionWs !== companionWs
  ) {
    safeSend(b.companionWs, {
      type: "replaced",
    });

    b.companionWs.boardId = null;
    b.companionWs.role = null;
  }

  b.companionWs = companionWs;
  b.locked = true;
  b.lastActive = Date.now();
  b.pendingWs = null;

  // Ensure the board's message state includes both
  // companion messages and API messages.
  b.messages = combineMessages(
    b.baseMessages,
    boardId,
  );

  companionWs.boardId = boardId;
  companionWs.role = "companion";

  safeSend(companionWs, {
    type: "paired",
    boardId,
    settings: b.settings,
    messages: b.messages,
    mode: b.mode,
    weatherPoint: b.weatherPoint,
    weatherStation: b.weatherStation,
  });

  safeSend(b.boardWs, {
    type: "companion_joined",
  });

  console.log(
    `Paired: ${boardId} (locked)`,
  );
}

// ─────────────────────────────────────────────────────────────
// WebSocket heartbeat
// ─────────────────────────────────────────────────────────────

const hb = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      return ws.terminate();
    }

    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on("close", () => clearInterval(hb));

// ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(
    `\n  splitflap.org server on http://localhost:${PORT}\n`,
  );

  console.log(
    `  Board:     http://localhost:${PORT}/board.html`,
  );

  console.log(
    `  Companion: http://localhost:${PORT}/companion.html\n`,
  );

  if (API_SECRET) {
    console.log(
      "  Home automation API: protected by X-API-Secret",
    );
  } else {
    console.log(
      "  Home automation API: NO SECRET CONFIGURED",
    );
  }

  console.log("");
});
