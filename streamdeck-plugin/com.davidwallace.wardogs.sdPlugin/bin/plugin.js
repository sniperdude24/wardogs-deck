// WARDOGS Deck Stream Deck plugin.
//
// Speaks the raw Stream Deck registration protocol (no SDK dependency —
// Node 24's built-in WebSocket and fetch are enough) and talks to the
// WARDOGS Deck desktop app over its local HTTP API. The app owns all
// ballistics; this file only relays dial/key input and paints the result.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ACTION_PREFIX = "com.davidwallace.wardogs.";
const DEFAULT_PORT = 8931;
const STEPS = [1, 0.1, 0.01];
const POLL_MS = 1000;
const REQUEST_TIMEOUT_MS = 1500;

/* ---------- logging ---------- */

const logFile = path.join(__dirname, "..", "logs", "plugin.log");
try {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
} catch {}
function log(message) {
  try {
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);
  } catch {}
}

/* ---------- launch args ---------- */

// Stream Deck launches us with: -port N -pluginUUID X -registerEvent Y -info {...}
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^-/, "")] = process.argv[i + 1];
}
if (!args.port || !args.pluginUUID || !args.registerEvent) {
  log(`missing launch args: ${process.argv.slice(2).join(" ")}`);
  process.exit(1);
}

/* ---------- state ---------- */

const contexts = new Map(); // context -> { action, settings, controller }
let globalSettings = {};
let lastState = null;
let online = false;
let pollTimer = null;

// Per-context dial coalescing: fast spins produce many ticks; we fold them
// into one pending delta per dial and send the next request only when the
// previous one has answered.
const pendingDelta = new Map();
const busyContexts = new Set();

// Last payload painted per context, so a state change that only touched
// one number does not re-send images for every key on the page.
const painted = new Map();

/* ---------- Stream Deck socket ---------- */

const ws = new WebSocket(`ws://127.0.0.1:${args.port}`);

function send(message) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(message));
  }
}

ws.addEventListener("open", () => {
  send({ event: args.registerEvent, uuid: args.pluginUUID });
  send({ event: "getGlobalSettings", context: args.pluginUUID });
  log(`registered as ${args.pluginUUID} on port ${args.port}`);
  poll();
  pollTimer = setInterval(poll, POLL_MS);
});

ws.addEventListener("close", () => {
  log("stream deck closed the socket; exiting");
  clearInterval(pollTimer);
  process.exit(0);
});

ws.addEventListener("error", (event) => log(`websocket error: ${event.message || event.type}`));

ws.addEventListener("message", (event) => {
  let message;
  try {
    message = JSON.parse(event.data);
  } catch {
    return;
  }
  try {
    handleMessage(message);
  } catch (error) {
    log(`handler error for ${message.event}: ${error.stack || error}`);
  }
});

function handleMessage(message) {
  const { event, context, action, payload = {} } = message;

  switch (event) {
    case "didReceiveGlobalSettings":
      globalSettings = payload.settings || {};
      poll();
      return;

    case "willAppear":
      contexts.set(context, {
        action,
        settings: payload.settings || {},
        controller: payload.controller || "Keypad",
      });
      if (payload.controller === "Encoder") {
        // Re-assert the layout so an updated layouts/axis.json wins over
        // whatever Stream Deck cached for a dial placed earlier.
        send({ event: "setFeedbackLayout", context, payload: { layout: "layouts/axis.json" } });
      }
      repaint(context);
      return;

    case "willDisappear":
      contexts.delete(context);
      pendingDelta.delete(context);
      busyContexts.delete(context);
      painted.delete(context);
      return;

    case "didReceiveSettings": {
      const entry = contexts.get(context);
      if (entry) {
        entry.settings = payload.settings || {};
        repaint(context);
      }
      return;
    }

    case "dialRotate":
      onDialRotate(context, payload);
      return;

    case "dialDown":
      onDialPress(context);
      return;

    case "touchTap":
      if (payload.hold) {
        onDialLongTouch(context);
      } else {
        onDialPress(context);
      }
      return;

    case "keyDown":
      onKeyDown(context, action);
      return;

    default:
      return;
  }
}

/* ---------- desktop app API ---------- */

function baseUrl() {
  const port = Number(globalSettings.port) || DEFAULT_PORT;
  return `http://127.0.0.1:${port}`;
}

async function api(pathname, body) {
  const response = await fetch(baseUrl() + pathname, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json.error || `HTTP ${response.status}`);
  }
  return json;
}

function setOnline(value) {
  if (online === value) return;
  online = value;
  log(value ? "app online" : "app offline");
  repaintAll();
}

function applyState(state) {
  if (!state) return;
  const changed = !lastState || lastState.gen !== state.gen;
  lastState = state;
  setOnline(true);
  if (changed) repaintAll();
}

async function poll() {
  try {
    const result = await api("/api/state");
    applyState(result.state);
  } catch {
    setOnline(false);
  }
}

// Relay a command; returns true on success. Failures flash the key.
async function command(body, context) {
  try {
    const result = await api("/api/cmd", body);
    applyState(result.state);
    return true;
  } catch (error) {
    log(`${body.cmd} -> ${error.message}`);
    setOnline(false);
    if (context) send({ event: "showAlert", context });
    return false;
  }
}

/* ---------- dial handling ---------- */

function axisSettings(entry) {
  const settings = entry.settings || {};
  const point = settings.point === "target" ? "target" : "origin";
  const axis = settings.axis === "y" ? "y" : "x";
  const step = STEPS.includes(Number(settings.step)) ? Number(settings.step) : 0.1;
  return { point, axis, step };
}

function onDialRotate(context, payload) {
  const entry = contexts.get(context);
  if (!entry || entry.action !== ACTION_PREFIX + "axis") return;

  const { step } = axisSettings(entry);
  const ticks = Number(payload.ticks) || 0;
  if (!ticks) return;

  pendingDelta.set(context, (pendingDelta.get(context) || 0) + ticks * step);
  flushDial(context);
}

async function flushDial(context) {
  if (busyContexts.has(context)) return;
  const entry = contexts.get(context);
  const delta = pendingDelta.get(context) || 0;
  if (!entry || !delta) return;

  pendingDelta.set(context, 0);
  busyContexts.add(context);

  const { point, axis } = axisSettings(entry);
  // Round away float drift from summing 0.01 steps.
  const rounded = Math.round(delta * 100) / 100;
  await command({ cmd: "nudge", point, axis, delta: rounded }, context);

  busyContexts.delete(context);
  if (pendingDelta.get(context)) flushDial(context);
}

function onDialPress(context) {
  const entry = contexts.get(context);
  if (!entry || entry.action !== ACTION_PREFIX + "axis") return;

  const { step } = axisSettings(entry);
  const next = STEPS[(STEPS.indexOf(step) + 1) % STEPS.length];
  entry.settings = { ...entry.settings, step: next };
  send({ event: "setSettings", context, payload: entry.settings });
  repaint(context);
}

// Long touch: copy this axis from the other point (Artillery <-> Target).
function onDialLongTouch(context) {
  const entry = contexts.get(context);
  if (!entry || entry.action !== ACTION_PREFIX + "axis" || !lastState) return;

  const { point, axis } = axisSettings(entry);
  const other = point === "origin" ? "target" : "origin";
  const value = lastState[other]?.[axis];
  if (!Number.isFinite(value)) return;

  command({ cmd: "set", point, [axis]: value }, context);
}

/* ---------- key handling ---------- */

async function onKeyDown(context, action) {
  const entry = contexts.get(context);
  if (!entry) return;
  const settings = entry.settings || {};

  switch (action) {
    case ACTION_PREFIX + "result":
      await onResultPress(context, settings);
      return;

    case ACTION_PREFIX + "weapon":
      await command({ cmd: "weapon-next" }, context);
      return;

    case ACTION_PREFIX + "swap":
      await command({ cmd: "swap" }, context);
      return;

    case ACTION_PREFIX + "target-save":
      if (await command({ cmd: "save-target" }, context)) send({ event: "showOk", context });
      return;

    case ACTION_PREFIX + "target-step":
      await command(
        { cmd: settings.direction === "prev" ? "target-prev" : "target-next" },
        context,
      );
      return;

    case ACTION_PREFIX + "app":
      await onAppKey(context, settings);
      return;

    default:
      return;
  }
}

// The Firing Solution key is a display first; what a press does is a setting.
const RESULT_PRESS_COMMANDS = {
  copy: { cmd: "copy" },
  swap: { cmd: "swap" },
  weapon: { cmd: "weapon-next" },
  save: { cmd: "save-target" },
  next: { cmd: "target-next" },
  prev: { cmd: "target-prev" },
};

async function onResultPress(context, settings) {
  const press = settings.press || "copy";
  if (press === "none") return;

  if (press === "focus") {
    await onAppKey(context, settings);
    return;
  }

  const body = RESULT_PRESS_COMMANDS[press];
  if (!body) return;

  const ok = await command(body, context);
  if (ok && (press === "copy" || press === "save")) send({ event: "showOk", context });
}

function candidateExePaths(settings) {
  const candidates = [];
  if (settings.exePath) candidates.push(settings.exePath);
  const local = process.env.LOCALAPPDATA;
  if (local) candidates.push(path.join(local, "wardogs-deck", "wardogs-deck.exe"));
  const programFiles = process.env.ProgramFiles;
  if (programFiles) candidates.push(path.join(programFiles, "wardogs-deck", "wardogs-deck.exe"));
  return candidates;
}

async function onAppKey(context, settings) {
  try {
    await api("/api/focus", {});
    send({ event: "showOk", context });
    return;
  } catch {
    setOnline(false);
  }

  const exe = candidateExePaths(settings).find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });

  if (!exe) {
    log("app key: no executable found; set the path in the action settings");
    send({ event: "showAlert", context });
    return;
  }

  try {
    const child = spawn(exe, [], { detached: true, stdio: "ignore", cwd: path.dirname(exe) });
    child.unref();
    log(`launched ${exe}`);
    send({ event: "showOk", context });
    // Give it a moment to start serving, then refresh.
    setTimeout(poll, 2500);
    setTimeout(poll, 5000);
  } catch (error) {
    log(`launch failed: ${error.message}`);
    send({ event: "showAlert", context });
  }
}

/* ---------- painting ---------- */

function repaintAll() {
  for (const context of contexts.keys()) repaint(context);
}

function repaint(context) {
  const entry = contexts.get(context);
  if (!entry) return;
  const state = online ? lastState : null;

  switch (entry.action) {
    case ACTION_PREFIX + "axis":
      paintAxis(context, entry, state);
      return;
    case ACTION_PREFIX + "result":
      paintResult(context, entry, state);
      return;
    case ACTION_PREFIX + "weapon":
      paintKey(context, state
        ? { label: "WEAPON", value: state.weaponName || state.weapon, tone: "neutral" }
        : offlineCard("WEAPON"));
      return;
    case ACTION_PREFIX + "swap":
      paintKey(context, state
        ? { label: "SWAP", value: "A <> T", sub: `${state.origin.xText},${state.origin.yText}`, tone: "neutral" }
        : offlineCard("SWAP"));
      return;
    case ACTION_PREFIX + "target-save":
      paintKey(context, state
        ? { label: "TARGET", value: "SAVE", sub: `${state.savedTargets.length} saved`, tone: "neutral" }
        : offlineCard("SAVE"));
      return;
    case ACTION_PREFIX + "target-step": {
      const prev = entry.settings?.direction === "prev";
      if (!state) {
        paintKey(context, offlineCard(prev ? "< PREV" : "NEXT >"));
        return;
      }
      const count = state.savedTargets.length;
      const index = state.activeTargetIndex;
      paintKey(context, {
        label: prev ? "< PREV" : "NEXT >",
        value: count ? (state.activeTargetName || "—") : "none",
        sub: count ? `${index >= 0 ? index + 1 : "-"}/${count}` : "no targets",
        tone: "neutral",
      });
      return;
    }
    case ACTION_PREFIX + "app":
      paintKey(context, {
        label: "WARDOGS",
        value: online ? "ONLINE" : "OFFLINE",
        sub: online ? (lastState?.mapName || "") : "press to launch",
        tone: online ? "ok" : "off",
      });
      return;
    default:
      return;
  }
}

// Point colours match the map markers in the app (blue artillery, red target).
const AXIS_COLORS = {
  origin: { tab: "#378ADD", label: "#85B7EB" },
  target: { tab: "#E24B4A", label: "#F09595" },
};
const GOLD = "#d9a441";

function stepLabel(step) {
  return step === 1 ? "1.00" : step === 0.1 ? ".10" : ".01";
}

// The touch strip above a dial is a 200x100 canvas painted as one SVG so the
// digit the dial moves can be highlighted and the step size drawn over it.
function paintAxis(context, entry, state) {
  const { point, axis, step } = axisSettings(entry);
  const colors = AXIS_COLORS[point];
  const title = `${point === "origin" ? "ART" : "TGT"} ${axis.toUpperCase()}`;
  const valueText = state ? String(state[point]?.[`${axis}Text`] ?? "—") : null;
  const font = 'font-family="Segoe UI, Arial, sans-serif" font-weight="700"';

  const parts = [];
  parts.push(`<rect x="0" y="0" width="200" height="100" fill="#000000"/>`);
  parts.push(`<rect x="0" y="0" width="7" height="100" fill="${state ? colors.tab : "#444444"}"/>`);
  parts.push(`<text x="17" y="23" font-size="15" ${font} fill="${state ? colors.label : "#7a7a7a"}">${escapeXml(title)}</text>`);

  if (!valueText) {
    parts.push(`<text x="103" y="72" font-size="26" ${font} text-anchor="middle" fill="#7a7a7a">OFFLINE</text>`);
  } else {
    // Lay the characters out in fixed cells so the highlight and the step
    // label line up with the digits regardless of font metrics.
    const size = 44;
    const chars = valueText.split("");
    const widths = chars.map((c) => (c === "." ? size * 0.28 : size * 0.56));
    let x = 103 - widths.reduce((sum, w) => sum + w, 0) / 2;
    const cells = chars.map((c, i) => {
      const cell = { c, x0: x, x1: x + widths[i] };
      x += widths[i];
      return cell;
    });

    const dot = chars.indexOf(".");
    let active = [];
    if (step === 1) active = cells.slice(0, dot < 0 ? cells.length : dot);
    else if (step === 0.1 && dot >= 0) active = cells.slice(dot + 1, dot + 2);
    else if (dot >= 0) active = cells.slice(dot + 2, dot + 3);
    const activeSet = new Set(active);

    cells.forEach((cell) => {
      parts.push(`<text x="${((cell.x0 + cell.x1) / 2).toFixed(1)}" y="80" font-size="${size}" ${font} text-anchor="middle" fill="${activeSet.has(cell) ? GOLD : "#ffffff"}">${escapeXml(cell.c)}</text>`);
    });

    if (active.length) {
      const ax0 = active[0].x0 + 1;
      const ax1 = active[active.length - 1].x1 - 1;
      parts.push(`<rect x="${ax0.toFixed(1)}" y="86" width="${(ax1 - ax0).toFixed(1)}" height="3" fill="${GOLD}"/>`);
      parts.push(`<text x="${((ax0 + ax1) / 2).toFixed(1)}" y="41" font-size="14" ${font} text-anchor="middle" fill="${GOLD}">${stepLabel(step)}</text>`);
    }
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">${parts.join("")}</svg>`;
  if (painted.get(context) === svg) return;
  painted.set(context, svg);
  send({
    event: "setFeedback",
    context,
    payload: { canvas: `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}` },
  });
}

function offlineCard(label) {
  return { label, value: "OFFLINE", sub: "start WARDOGS Deck", tone: "off" };
}

function paintResult(context, entry, state) {
  const field = entry.settings?.field || "dam";

  if (!state) {
    paintKey(context, offlineCard(field === "dam" ? "D / A / M" : field.toUpperCase()));
    return;
  }

  const tone = state.inRange ? "ok" : "warn";
  const azimuth = `${Number(state.azimuth).toFixed(1)}°`;
  const distance = `${Math.round(state.distanceM)} m`;
  const mil = state.mil || {};
  const hasPair = Number.isFinite(mil.low) && Number.isFinite(mil.high);
  const milCompact = hasPair ? `${Math.round(mil.low)}/${Math.round(mil.high)}` : (mil.text || "—");

  switch (field) {
    case "dam":
      paintKey(context, {
        rows: [
          { k: "D:", v: distance },
          { k: "A:", v: azimuth },
          { k: "M:", v: milCompact },
        ],
        tone,
      });
      return;
    case "azimuth":
      paintKey(context, { label: "AZIMUTH", value: azimuth, sub: `${state.weaponName}`, tone });
      return;
    case "distance":
      paintKey(context, {
        label: "DISTANCE",
        value: distance,
        sub: state.inRange ? state.rangeText : "OUT OF RANGE",
        tone,
      });
      return;
    case "all":
      paintKey(context, {
        label: "SOLUTION",
        lines: [`AZ ${azimuth}`, hasPair ? `MIL ${Math.round(mil.low)}/${Math.round(mil.high)}` : `MIL ${mil.text}`, distance],
        tone,
      });
      return;
    case "mil":
    default:
      if (hasPair) {
        paintKey(context, {
          label: "MIL",
          lines: [`LOW ${Math.round(mil.low)}`, `HIGH ${Math.round(mil.high)}`],
          sub: mil.detail || "",
          tone,
        });
      } else {
        paintKey(context, {
          label: "MIL",
          value: mil.text || "—",
          sub: state.inRange ? mil.detail || "" : "OUT OF RANGE",
          tone,
        });
      }
      return;
  }
}

// Colours follow the app's own result panel: near-black card, gold label,
// white value. Red border + red label when out of range, grey when offline.
const TONES = {
  ok: { bg: "#141414", border: "#3a3428", label: "#d9a441", value: "#ffffff", sub: "#9a9a9a" },
  warn: { bg: "#1c1212", border: "#c0392b", label: "#ff8a80", value: "#ffffff", sub: "#ff8a80" },
  off: { bg: "#141414", border: "#333333", label: "#7a7a7a", value: "#9a9a9a", sub: "#6a6a6a" },
  neutral: { bg: "#141414", border: "#3a3428", label: "#d9a441", value: "#ffffff", sub: "#9a9a9a" },
};

function rowFontSize(text) {
  const length = String(text).length;
  if (length <= 8) return 28;
  if (length <= 10) return 24;
  return 20;
}

function escapeXml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function valueFontSize(text) {
  const length = String(text).length;
  if (length <= 4) return 46;
  if (length <= 6) return 38;
  if (length <= 8) return 30;
  if (length <= 11) return 24;
  return 19;
}

// Renders a 144x144 key as an SVG data URL.
function paintKey(context, card) {
  const tone = TONES[card.tone] || TONES.neutral;
  const parts = [];
  parts.push(`<rect x="4" y="4" width="136" height="136" rx="18" fill="${tone.bg}" stroke="${tone.border}" stroke-width="5"/>`);

  if (Array.isArray(card.rows)) {
    // Three "K: value" rows, left aligned, label in gold and value in white.
    const rows = card.rows.slice(0, 3);
    const gap = 40;
    const start = 72 - ((rows.length - 1) * gap) / 2 + 10;
    rows.forEach((row, index) => {
      const size = rowFontSize(`${row.k} ${row.v}`);
      parts.push(
        `<text x="14" y="${start + index * gap}" text-anchor="start" font-family="Segoe UI, Arial, sans-serif" font-size="${size}" font-weight="700">` +
          `<tspan fill="${tone.label}">${escapeXml(row.k)}</tspan>` +
          `<tspan fill="${tone.value}"> ${escapeXml(row.v)}</tspan>` +
          `</text>`,
      );
    });
    finishKey(context, parts);
    return;
  }

  parts.push(`<text x="72" y="32" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="17" font-weight="600" fill="${tone.label}">${escapeXml(card.label)}</text>`);

  if (Array.isArray(card.lines)) {
    const lines = card.lines.slice(0, 3);
    const size = lines.length === 3 ? 24 : 28;
    const start = lines.length === 3 ? 62 : 70;
    const gap = lines.length === 3 ? 28 : 34;
    lines.forEach((line, index) => {
      parts.push(`<text x="72" y="${start + index * gap}" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="${size}" font-weight="700" fill="${tone.value}">${escapeXml(line)}</text>`);
    });
  } else {
    const size = valueFontSize(card.value);
    parts.push(`<text x="72" y="${card.sub ? 88 : 96}" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="${size}" font-weight="700" fill="${tone.value}">${escapeXml(card.value)}</text>`);
  }

  if (card.sub) {
    parts.push(`<text x="72" y="124" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="15" font-weight="500" fill="${tone.sub}">${escapeXml(card.sub)}</text>`);
  }

  finishKey(context, parts);
}

function finishKey(context, parts) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">${parts.join("")}</svg>`;
  if (painted.get(context) === svg) return;
  painted.set(context, svg);
  send({
    event: "setImage",
    context,
    payload: { image: `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`, target: 0 },
  });
}
