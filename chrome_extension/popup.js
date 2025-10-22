const DEFAULT_HOST = "http://127.0.0.1:8123";
const STORAGE_DEFAULTS = {
  bridgeHost: DEFAULT_HOST,
  sendTrimmedState: true,
};

const SYSTEM_INSTRUCTIONS = `You are an expert Slay the Spire planner that outputs an action SEQUENCE.
Rules:
- Return ONLY JSON that matches the provided schema (no prose, markdown, or comments).
- Prefer CommunicationMod-native commands: play, end, wait, key, choose, state. Use click ONLY when no command-based option exists.
- Issue play steps with args.uuid for the card to play.
- When a play requires a target, provide target_index (1-based), target_uuid, monster, or enemy descriptors in args. Do NOT add click coordinates for targeting.
- Indices are 1-based unless otherwise stated; the frontmost enemy is target_index 1.
- Use choose with an index when selecting from menus or rewards instead of click.
- Keep sequences short (<=5 steps). If no legal action is available, return {"sequence":[]} to request more information.`;

const ACTION_SCHEMA = {
  name: "ActionSequence",
  schema: {
    type: "object",
    properties: {
      sequence: {
        type: "array",
        items: {
          type: "object",
          properties: {
            command: {
              type: "string",
              enum: ["key", "click", "choose", "wait", "state", "play", "end"],
            },
            args: {
              type: "object",
              properties: {
                value: { type: "string" },
                index: { type: "integer" },
                ms: { type: "integer", minimum: 0 },
                x: { type: "integer" },
                y: { type: "integer" },
                uuid: { type: "string" },
                click: {
                  type: "object",
                  properties: {
                    x: { type: "integer" },
                    y: { type: "integer" },
                  },
                  required: ["x", "y"],
                  additionalProperties: false,
                },
              },
              additionalProperties: true,
            },
          },
          required: ["command", "args"],
          additionalProperties: false,
        },
      },
    },
    required: ["sequence"],
    additionalProperties: false,
  },
  strict: true,
};

const HAND_SELECT_FOLLOWUP_LIMIT = 3;
const HAND_SELECT_STATE_DELAY_MS = 250;

let settings = { ...STORAGE_DEFAULTS };
let lastTrimmedState = null;
let lastFullState = null;
let lastStateJSON = "";
let lastPromptText = "";
let lastChatGPTResponseText = "";
let handSelectFollowupAttempts = 0;
let handSelectFollowupPending = false;

function storageAvailable() {
  return typeof chrome !== "undefined" && !!(chrome.storage && chrome.storage.local);
}

async function loadSettings() {
  if (!storageAvailable()) {
    settings = { ...STORAGE_DEFAULTS };
    return settings;
  }
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_DEFAULTS, (items) => {
      settings = {
        bridgeHost: (items.bridgeHost || DEFAULT_HOST).replace(/\/$/, ""),
        sendTrimmedState:
          typeof items.sendTrimmedState === "boolean" ? items.sendTrimmedState : true,
      };
      resolve(settings);
    });
  });
}

async function persistSettings(partial) {
  settings = { ...settings, ...partial };
  if (!storageAvailable()) {
    return;
  }
  return new Promise((resolve) => {
    chrome.storage.local.set(
      {
        bridgeHost: settings.bridgeHost,
        sendTrimmedState: settings.sendTrimmedState,
      },
      resolve,
    );
  });
}

function applySettingsToInputs() {
  const hostInput = document.getElementById("host-input");
  const trimmedCheckbox = document.getElementById("trimmed-to-gpt");

  hostInput.value = settings.bridgeHost;
  trimmedCheckbox.checked = settings.sendTrimmedState;
}

function readSettingsFromInputs() {
  const hostValue = (document.getElementById("host-input").value || "").trim() || DEFAULT_HOST;
  const sendTrimmed = document.getElementById("trimmed-to-gpt").checked;
  return {
    bridgeHost: hostValue.replace(/\/$/, ""),
    sendTrimmedState: sendTrimmed,
  };
}

function log(message, type = "info") {
  const consoleEl = document.getElementById("console-output");
  const timestamp = new Date().toLocaleTimeString();
  consoleEl.textContent = `[${timestamp}] (${type}) ${message}\n` + consoleEl.textContent;
}

function handleChatGPTStatus(message) {
  if (!message || !message.status) {
    return;
  }
  const status = message.status;
  switch (status) {
    case "prompt_submitted":
      log("ChatGPT prompt submitted; waiting for response...", "debug");
      break;
    case "waiting_for_response":
      log("Waiting for ChatGPT to finish responding...", "info");
      break;
    case "response_streaming": {
      const preview = (message.preview || "").replace(/\s+/g, " ").trim();
      if (preview) {
        const truncated = preview.length > 120 ? `${preview.slice(0, 120)}…` : preview;
        log(`ChatGPT streaming response preview: ${truncated}`, "debug");
      } else {
        log("ChatGPT has started streaming a response.", "debug");
      }
      break;
    }
    case "response_ready":
      log(
        `ChatGPT response finalized (${message.length !== undefined ? message.length : "unknown"} characters).`,
        "debug",
      );
      break;
    case "response_error":
      log(`ChatGPT response error: ${message.error || "unknown error"}`, "error");
      break;
    default:
      log(`ChatGPT status update: ${status}`, "debug");
  }
}

function setHealth(status, text) {
  const el = document.getElementById("health");
  el.textContent = text;
  el.classList.remove("unknown", "ok", "error");
  el.classList.add(status);
}

function buildBridgeUrl(path) {
  const base = settings.bridgeHost || DEFAULT_HOST;
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }
  return `${base}${path}`;
}

async function fetchJSON(path, options = {}) {
  const url = buildBridgeUrl(path);
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return await res.json();
  }
  return await res.text();
}

function setStateDisplay(state) {
  const output = document.getElementById("state-output");
  if (state === null || state === undefined) {
    lastStateJSON = "";
    output.textContent = "";
    return;
  }
  lastStateJSON = JSON.stringify(state, null, 2);
  output.textContent = lastStateJSON;
}

function setPromptDisplay(prompt) {
  const output = document.getElementById("plan-output");
  if (!prompt) {
    lastPromptText = "";
    output.textContent = "";
    return;
  }
  lastPromptText = prompt;
  output.textContent = lastPromptText;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function upper(text) {
  if (text === null || text === undefined) {
    return "";
  }
  return String(text).trim().toUpperCase();
}

function parseMaybeNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function cardLabelFromObject(card) {
  if (!card || typeof card !== "object") {
    return null;
  }
  const nameKeys = ["name", "card_name", "cardName", "label", "display", "id", "card_id", "cardId"];
  for (const key of nameKeys) {
    if (key in card && card[key]) {
      const text = String(card[key]).trim();
      if (text) {
        return text;
      }
    }
  }
  if ("uuid" in card && card.uuid) {
    return String(card.uuid).trim();
  }
  return null;
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (!value) {
      continue;
    }
    const canonical = value.toLowerCase();
    if (seen.has(canonical)) {
      continue;
    }
    seen.add(canonical);
    result.push(value);
  }
  return result;
}

function analyzeHandSelectState(envelope) {
  if (!envelope || typeof envelope !== "object") {
    return null;
  }
  const gameState = envelope.game_state && typeof envelope.game_state === "object" ? envelope.game_state : {};
  const screenTypeRaw = gameState.screen_type || envelope.screen_type || "";
  if (upper(screenTypeRaw) !== "HAND_SELECT") {
    return null;
  }
  const screenState = gameState.screen_state && typeof gameState.screen_state === "object" ? gameState.screen_state : {};
  const choiceList = Array.isArray(gameState.choice_list) ? gameState.choice_list : [];
  const handCards = Array.isArray(screenState.hand) ? screenState.hand : [];
  const selectedCards = Array.isArray(screenState.selected) ? screenState.selected : [];
  const maxCards =
    parseMaybeNumber(screenState.max_cards ?? screenState.maxCards ?? screenState.num_cards ?? screenState.numCards);
  const remaining = typeof maxCards === "number" ? Math.max(0, maxCards - selectedCards.length) : null;
  const canPickZero = Boolean(screenState.can_pick_zero ?? screenState.canPickZero);
  const needsChoice = remaining === null ? choiceList.length > 0 : remaining > 0;
  if (!needsChoice) {
    return null;
  }
  return {
    remaining: remaining === null ? 1 : remaining,
    canPickZero,
    choiceList,
    handCards,
  };
}

async function maybeHandlePendingHandSelect({ origin }) {
  try {
    await wait(HAND_SELECT_STATE_DELAY_MS);
  } catch (err) {
    console.error(err);
  }

  let trimmedState;
  try {
    const { trimmed } = await refreshState({ silent: true });
    trimmedState = trimmed;
  } catch (err) {
    log(`Follow-up state refresh failed: ${err.message}`, "debug");
    return;
  }

  const context = analyzeHandSelectState(trimmedState);
  if (!context) {
    if (handSelectFollowupAttempts > 0 || handSelectFollowupPending) {
      log("Hand select follow-up cleared; ready for next command.", "debug");
    }
    handSelectFollowupAttempts = 0;
    handSelectFollowupPending = false;
    return;
  }

  const optionNames = uniqueStrings([
    ...context.choiceList.map((item) => (typeof item === "string" ? item.trim() : "")),
    ...context.handCards.map((card) => cardLabelFromObject(card)).filter(Boolean),
  ]);
  if (optionNames.length) {
    const preview = optionNames.slice(0, 8).join(", ");
    log(`Pending hand selection options: ${preview}`, "debug");
  }

  const remainingText = context.remaining > 1 ? `${context.remaining} cards` : "1 card";
  const extraNote = context.canPickZero ? " (skipping may also be allowed)" : "";
  log(`Card selection detected: choose ${remainingText} to continue${extraNote}.`, "warning");

  if (origin === "auto") {
    if (handSelectFollowupAttempts >= HAND_SELECT_FOLLOWUP_LIMIT) {
      log(
        `Reached the automatic follow-up limit (${HAND_SELECT_FOLLOWUP_LIMIT}). Review the state and send a choose command manually.`,
        "warning",
      );
      handSelectFollowupPending = false;
      return;
    }
    handSelectFollowupAttempts += 1;
    handSelectFollowupPending = true;
    log(`Requesting follow-up command from ChatGPT to resolve the hand selection (attempt ${handSelectFollowupAttempts}).`, "info");
    try {
      await planAction({ execute: true });
    } catch (err) {
      log(`Hand select follow-up planning failed: ${err.message}`, "error");
    } finally {
      handSelectFollowupPending = false;
    }
  } else {
    log("Run Plan + Execute or send a choose command manually to finish the selection.", "info");
    handSelectFollowupPending = false;
  }
}

function extractJSONObjectString(text) {
  if (!text) {
    return null;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) {
    return fence[1].trim();
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1).trim();
  }
  return null;
}

function parseChatGPTSequence(text) {
  const candidate = extractJSONObjectString(text);
  if (!candidate) {
    throw new Error("Could not locate a JSON object in ChatGPT's response.");
  }
  let payload;
  try {
    payload = JSON.parse(candidate);
  } catch (err) {
    throw new Error(`ChatGPT response JSON parse failed: ${err.message}`);
  }
  let steps = null;
  if (Array.isArray(payload)) {
    steps = payload;
  } else if (payload && typeof payload === "object") {
    if (Array.isArray(payload.sequence)) {
      steps = payload.sequence;
    } else if (Array.isArray(payload.steps)) {
      steps = payload.steps;
    }
  }
  if (!Array.isArray(steps)) {
    throw new Error("ChatGPT response is missing a 'sequence' array.");
  }
  return { steps, rawJSON: candidate, payload };
}

async function refreshHealth() {
  try {
    const data = await fetchJSON("/health");
    setHealth("ok", data.status || "ok");
    log("Bridge healthy", "success");
  } catch (err) {
    console.error(err);
    setHealth("error", "offline");
    log(`Health check failed: ${err.message}`, "error");
  }
}

function stateDisplayPreference() {
  return document.getElementById("full-state").checked;
}

async function fetchState({ full = false, refresh = true } = {}) {
  const params = new URLSearchParams();
  if (full) {
    params.set("full", "1");
  }
  if (!refresh) {
    params.set("refresh", "0");
  }
  const query = params.toString();
  const path = `/state${query ? `?${query}` : ""}`;
  return await fetchJSON(path);
}

async function refreshState({ silent = false } = {}) {
  const wantFull = stateDisplayPreference();
  if (!silent) {
    log(`Manual state refresh requested. Want full state: ${wantFull}`, "debug");
  } else {
    log(`Background state refresh running. Want full state: ${wantFull}`, "debug");
  }
  const output = document.getElementById("state-output");
  output.textContent = "Loading...";
  try {
    log("Requesting trimmed state from bridge.", "debug");
    const trimmed = await fetchState({ full: false, refresh: true });
    lastTrimmedState = trimmed;
    log(
      trimmed && Object.keys(trimmed).length
        ? `Trimmed state received with ${Object.keys(trimmed).length} key(s).`
        : "Trimmed state fetch returned empty payload.",
      "debug",
    );
    let displayState = trimmed;
    if (wantFull) {
      try {
        log("Want full state; requesting from bridge without refresh.", "debug");
        const fullState = await fetchState({ full: true, refresh: false });
        lastFullState = fullState;
        displayState = fullState;
        log("Full state fetch succeeded for display.", "debug");
      } catch (err) {
        log(`Full state unavailable: ${err.message}`, "warning");
      }
    }
    if (!wantFull) {
      // keep last full state from previous fetch if any
      if (!lastFullState) {
        lastFullState = null;
      }
    }
    setStateDisplay(displayState);
    if (!silent) {
      log("Fetched state", "success");
    } else {
      log("Background state refresh complete.", "debug");
    }
    return { trimmed, displayState };
  } catch (err) {
    output.textContent = "Error fetching state";
    log(`State refresh encountered error: ${err.message}`, "debug");
    log(`State fetch failed: ${err.message}`, "error");
    throw err;
  }
}

async function copyToClipboard(text, label) {
  if (!text) {
    log(`${label} is empty`, "warning");
    return false;
  }
  try {
    await navigator.clipboard.writeText(text);
    log(`${label} copied to clipboard`, "success");
    return true;
  } catch (err) {
    log(`Clipboard unavailable for ${label.toLowerCase()}: ${err.message}`, "warning");
    return false;
  }
}

async function snapshotAction() {
  try {
    const { trimmed } = await refreshState({ silent: true });
    if (!trimmed) {
      log("No state received during snapshot.", "warning");
      return;
    }
    const trimmedJSON = JSON.stringify(trimmed, null, 2);
    const copied = await copyToClipboard(trimmedJSON, "Trimmed snapshot");
    if (!copied) {
      log("Snapshot ready (clipboard unavailable).", "info");
    }
    log("Snapshot captured", "success");
  } catch (err) {
    // refreshState already logged the failure
  }
}

function buildPlannerPrompt(payload) {
  const schemaText = JSON.stringify(ACTION_SCHEMA.schema, null, 2);
  const stateJSON = JSON.stringify(payload, null, 2);
  return [
    SYSTEM_INSTRUCTIONS,
    "",
    "Action schema (JSON Schema):",
    schemaText,
    "",
    "Current run state JSON:",
    stateJSON,
    "",
    "Return only the sequence object that matches the schema.",
  ].join("\n");
}

const CHATGPT_ORIGIN = "https://chatgpt.com/*";

function isChatGPTUrl(url) {
  if (typeof url !== "string") {
    return false;
  }
  return url === "https://chatgpt.com" || url.startsWith("https://chatgpt.com/");
}

function looksLikeChatGPT(tab) {
  if (!tab) {
    return false;
  }
  if (isChatGPTUrl(tab.url) || isChatGPTUrl(tab.pendingUrl)) {
    return true;
  }
  const title = tab.title || "";
  return /chatgpt/i.test(title);
}

async function ensureChatGPTHostPermission() {
  if (!chrome.permissions || !chrome.permissions.contains) {
    log("chrome.permissions API unavailable; assuming chatgpt.com access granted.", "debug");
    return;
  }

  const alreadyGranted = await new Promise((resolve) => {
    chrome.permissions.contains({ origins: [CHATGPT_ORIGIN] }, (result) => {
      if (chrome.runtime && chrome.runtime.lastError) {
        log(
          `chrome.permissions.contains failed: ${chrome.runtime.lastError.message}. Assuming no permission.`,
          "debug",
        );
        resolve(false);
        return;
      }
      resolve(result);
    });
  });

  if (alreadyGranted) {
    log("Host permission for chatgpt.com already granted.", "debug");
    return;
  }

  log("Requesting chatgpt.com access so the extension can read the tab URL.", "warning");
  const granted = await new Promise((resolve) => {
    chrome.permissions.request({ origins: [CHATGPT_ORIGIN] }, (result) => {
      if (chrome.runtime && chrome.runtime.lastError) {
        log(
          `chrome.permissions.request failed: ${chrome.runtime.lastError.message}.`,
          "error",
        );
        resolve(false);
        return;
      }
      resolve(result);
    });
  });

  if (granted) {
    log("chatgpt.com access granted. Continuing with tab discovery.", "info");
  } else {
    log(
      "chatgpt.com access was not granted. Please allow the permission from the Chrome prompt and retry.",
      "error",
    );
  }
}

function describeTabUrl(tab) {
  if (!tab) {
    return "unknown";
  }
  return tab.url || tab.pendingUrl || "unknown";
}

async function getBestChatGPTTab() {
  if (typeof chrome === "undefined" || !chrome.tabs || !chrome.tabs.query) {
    throw new Error("Chrome tabs API unavailable in this context.");
  }

  log("Starting chatgpt.com tab discovery.", "debug");
  await ensureChatGPTHostPermission();

  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (activeTab) {
    log(`Last focused active tab: ${describeTabUrl(activeTab)}`, "debug");
  } else {
    log("No last-focused active tab returned by chrome.tabs.query.", "debug");
  }
  if (looksLikeChatGPT(activeTab)) {
    log("Last-focused active tab looks like chatgpt.com; using it.", "debug");
    return activeTab;
  }

  const activeTabs = await chrome.tabs.query({ active: true });
  log(`Scanning ${activeTabs.length} active tab(s) across all windows for chatgpt.com.`, "debug");
  for (const tab of activeTabs) {
    log(`Checking active tab candidate: ${describeTabUrl(tab)}`, "debug");
    if (looksLikeChatGPT(tab)) {
      if (tab.id !== (activeTab && activeTab.id)) {
        log(
          `Using chatgpt.com tab from a different window (URL: ${describeTabUrl(tab)}). ` +
            "If sending fails, click that tab and retry.",
          "warning",
        );
      }
      return tab;
    }
  }

  const candidates = await chrome.tabs.query({ url: [CHATGPT_ORIGIN] });
  log(
    candidates && candidates.length
      ? `Found ${candidates.length} historical chatgpt.com tab candidate(s).`
      : "No chatgpt.com tabs found by URL search.",
    "debug",
  );
  if (candidates && candidates.length > 0) {
    candidates.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    const recent = candidates[0];
    log(
      recent
        ? `Most recently accessed chatgpt.com tab: ${describeTabUrl(recent)} (title: ${recent.title || "<no title>"})`
        : "Unable to determine most recent chatgpt.com tab despite candidates list.",
      "debug",
    );
    if (recent) {
      if (recent.id !== (activeTab && activeTab.id)) {
        log(
          `Using chatgpt.com tab that isn't currently focused (URL: ${describeTabUrl(recent)}). ` +
            "If sending fails, click that tab and retry.",
          "warning",
        );
      }
      return recent;
    }
  }

  const details = activeTab
    ? `Active tab URL detected: ${describeTabUrl(activeTab)}`
    : "No active tab detected.";
  log(`ChatGPT tab discovery failed. ${details}`, "debug");
  throw new Error(`Could not find a chatgpt.com tab. ${details}`);
}

async function pingChatGPTContentScript(tabId) {
  if (!chrome.tabs || !chrome.tabs.sendMessage) {
    throw new Error("chrome.tabs.sendMessage unavailable for ping.");
  }
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.sendMessage(tabId, { type: "PING" }, (reply) => {
        if (chrome.runtime && chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(Boolean(reply && reply.ok));
      });
    } catch (err) {
      reject(err);
    }
  });
}

async function ensureChatGPTContentScript(tabId) {
  if (!tabId) {
    throw new Error("Cannot ensure content script without a tab id.");
  }

  try {
    const pingResult = await pingChatGPTContentScript(tabId);
    if (pingResult) {
      log("ChatGPT content script responded to ping; no reinjection needed.", "debug");
      return;
    }
    log("Ping response did not indicate readiness; attempting reinjection.", "debug");
  } catch (err) {
    log(`Initial content script ping failed: ${err.message}`, "debug");
  }

  if (!chrome.scripting || !chrome.scripting.executeScript) {
    throw new Error("ChatGPT helper script missing and chrome.scripting API unavailable.");
  }

  log("Attempting runtime injection of chatgpt_inject.js into the ChatGPT tab.", "debug");
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["chatgpt_inject.js"],
    });
  } catch (err) {
    log(`chrome.scripting.executeScript failed: ${err && err.message ? err.message : err}`, "error");
    throw new Error(`Unable to inject ChatGPT helper script: ${err.message || err}`);
  }
  log("Runtime injection completed; verifying content script responsiveness.", "debug");

  try {
    const pingResult = await pingChatGPTContentScript(tabId);
    if (pingResult) {
      log("ChatGPT content script responsive after runtime injection.", "debug");
      return;
    }
    throw new Error("Ping acknowledgement missing after runtime injection.");
  } catch (err) {
    log(`Content script still unavailable after reinjection attempt: ${err.message}`, "error");
    throw new Error(`ChatGPT helper failed to initialize: ${err.message}`);
  }
}

async function sendPromptToChatGPT(prompt) {
  if (typeof chrome === "undefined" || !chrome.tabs || !chrome.tabs.sendMessage) {
    throw new Error("Chrome tabs messaging API unavailable in this context.");
  }
  log("Resolving ChatGPT tab before sending prompt.", "debug");
  const tab = await getBestChatGPTTab();
  log("Ensuring ChatGPT content script is active before sending.", "debug");
  await ensureChatGPTContentScript(tab.id);
  log(`Resolved ChatGPT tab ${tab.id} (${describeTabUrl(tab)}). Sending prompt message.`, "debug");
  const response = await new Promise((resolve, reject) => {
    try {
      chrome.tabs.sendMessage(tab.id, { type: "SEND_PROMPT", prompt }, (reply) => {
        if (chrome.runtime && chrome.runtime.lastError) {
          log(
            `chrome.tabs.sendMessage reported runtime error: ${chrome.runtime.lastError.message}`,
            "debug",
          );
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        log("Received response payload from ChatGPT tab content script.", "debug");
        resolve(reply);
      });
    } catch (err) {
      log(`chrome.tabs.sendMessage threw synchronously: ${err.message}`, "debug");
      reject(err);
    }
  });
  if (response && response.ok) {
    log("Content script acknowledged prompt delivery.", "debug");
    if (response.responseText && typeof response.responseText === "string") {
      return response.responseText;
    }
    log("ChatGPT response text missing from content script payload.", "warning");
    return "";
  }
  if (response && response.error) {
    log(`Content script responded with error: ${response.error}`, "debug");
    throw new Error(response.error);
  }
  log("Content script gave no response to prompt message.", "debug");
  throw new Error("No response from ChatGPT content script. Reload the tab and try again.");
}

async function handleChatGPTReply(responseText, { execute }) {
  lastChatGPTResponseText = (responseText || "").trim();
  if (!lastChatGPTResponseText) {
    log("ChatGPT response was empty; nothing to process.", "warning");
    log("Copy the response from ChatGPT manually if one was produced.", "info");
    return;
  }

  let parsed;
  try {
    parsed = parseChatGPTSequence(lastChatGPTResponseText);
  } catch (err) {
    log(`Failed to parse ChatGPT response: ${err.message}`, "error");
    log("Copy the sequence directly from ChatGPT and send it via the form if needed.", "info");
    return;
  }

  const steps = parsed.steps;
  const preview = parsed.rawJSON.length > 140 ? `${parsed.rawJSON.slice(0, 140)}…` : parsed.rawJSON;
  log(`ChatGPT sequence JSON captured: ${preview}`, "debug");

  const field = document.getElementById("sequence-steps");
  if (field) {
    field.value = JSON.stringify(steps, null, 2);
  }

  log(`Captured ChatGPT sequence with ${steps.length} step(s).`, "success");

  if (execute) {
    try {
      await postSequenceSteps(steps, { origin: "auto" });
    } catch (err) {
      log(`Auto sequence send failed: ${err.message}`, "error");
    }
  } else {
    log("Sequence populated in the Send Sequence form for manual review.", "info");
  }
}

async function planAction({ execute }) {
  const planOutput = document.getElementById("plan-output");
  planOutput.textContent = "Preparing prompt...";
  try {
    log("Starting planner flow: refreshing state for prompt generation.", "debug");
    const { trimmed } = await refreshState({ silent: true });
    log(
      trimmed && Object.keys(trimmed).length
        ? `Trimmed state fetched with ${Object.keys(trimmed).length} top-level key(s).`
        : "Trimmed state fetch returned empty payload.",
      "debug",
    );
    if (!trimmed || Object.keys(trimmed).length === 0) {
      throw new Error("No state received before planning.");
    }
    const sendTrimmed = document.getElementById("trimmed-to-gpt").checked;
    settings.sendTrimmedState = sendTrimmed;
    log(`Planner using ${sendTrimmed ? "trimmed" : "full"} state payload.`, "debug");
    let payload = trimmed;
    if (!sendTrimmed) {
      try {
        log("Fetching full state payload for planner.", "debug");
        const fullState = await fetchState({ full: true, refresh: false });
        lastFullState = fullState;
        if (stateDisplayPreference()) {
          setStateDisplay(fullState);
        }
        payload = fullState;
      } catch (err) {
        log(`Full state fetch failed inside planner: ${err.message}`, "debug");
        throw new Error(`Failed to fetch full state: ${err.message}`);
      }
    }
    log("Building planner prompt text.", "debug");
    const prompt = buildPlannerPrompt(payload);
    setPromptDisplay(prompt);
    try {
      log("Attempting to deliver planner prompt to ChatGPT tab.", "debug");
      const replyText = await sendPromptToChatGPT(prompt);
      log("ChatGPT response received from content script.", "success");
      await handleChatGPTReply(replyText, { execute });
    } catch (err) {
      log(`Could not send prompt automatically: ${err.message}`, "warning");
      log("Copy the prompt and paste it into ChatGPT manually.", "info");
    }
  } catch (err) {
    planOutput.textContent = "Prompt generation failed.";
    log(`Planning failed: ${err.message}`, "error");
  }
}

function parseJSONField(value, fallback) {
  if (!value.trim()) {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch (err) {
    throw new Error(`Invalid JSON: ${err.message}`);
  }
}

async function sendCommand(event) {
  event.preventDefault();
  const name = document.getElementById("command-name").value;
  const argsField = document.getElementById("command-args");
  let args = {};
  try {
    args = parseJSONField(argsField.value, {});
  } catch (err) {
    log(err.message, "error");
    argsField.focus();
    return;
  }
  try {
    const resp = await fetchJSON("/command", {
      method: "POST",
      body: JSON.stringify({ command: name, args }),
    });
    log(`Command sent: ${JSON.stringify(resp)}`, "success");
  } catch (err) {
    log(`Command failed: ${err.message}`, "error");
  }
}

async function postSequenceSteps(steps, { origin = "manual" } = {}) {
  if (!Array.isArray(steps)) {
    throw new Error("Sequence must be an array of steps");
  }
  const label = origin === "auto" ? "Auto sequence" : "Sequence";
  log(`Sending ${origin === "auto" ? "captured" : "manual"} sequence to bridge...`, "info");
  const resp = await fetchJSON("/sequence", {
    method: "POST",
    body: JSON.stringify({ steps }),
  });
  log(`${label} sent: ${JSON.stringify(resp)}`, "success");
  try {
    await maybeHandlePendingHandSelect({ origin });
  } catch (err) {
    log(`Follow-up handling failed: ${err.message}`, "debug");
  }
  return resp;
}

async function sendSequence(event) {
  event.preventDefault();
  const field = document.getElementById("sequence-steps");
  let parsed = [];
  let steps = [];
  try {
    parsed = parseJSONField(field.value, []);
    if (Array.isArray(parsed)) {
      steps = parsed;
    } else if (parsed && typeof parsed === "object") {
      if (Array.isArray(parsed.sequence)) {
        steps = parsed.sequence;
      } else if (Array.isArray(parsed.steps)) {
        steps = parsed.steps;
      }
    }
    if (!Array.isArray(steps)) {
      throw new Error("Sequence must be a JSON array or an object with a sequence/steps array");
    }
  } catch (err) {
    log(err.message, "error");
    field.focus();
    return;
  }
  try {
    await postSequenceSteps(steps, { origin: "manual" });
  } catch (err) {
    log(`Sequence failed: ${err.message}`, "error");
  }
}

async function sendLog(event) {
  event.preventDefault();
  const field = document.getElementById("log-message");
  const message = field.value.trim();
  if (!message) {
    log("Log message cannot be empty", "warning");
    field.focus();
    return;
  }
  try {
    const resp = await fetchJSON("/log", {
      method: "POST",
      body: JSON.stringify({ message }),
    });
    log(`Logged message: ${JSON.stringify(resp)}`, "success");
    field.value = "";
  } catch (err) {
    log(`Log failed: ${err.message}`, "error");
  }
}

async function saveSettings() {
  const values = readSettingsFromInputs();
  try {
    new URL(values.bridgeHost);
  } catch (err) {
    log(`Invalid URL: ${values.bridgeHost}`, "error");
    document.getElementById("host-input").focus();
    return;
  }
  await persistSettings(values);
  applySettingsToInputs();
  log(`Settings saved. Bridge URL set to ${settings.bridgeHost}`, "success");
}

function onFullStateToggle() {
  if (stateDisplayPreference()) {
    if (lastFullState) {
      setStateDisplay(lastFullState);
    } else {
      refreshState();
    }
  } else if (lastTrimmedState) {
    setStateDisplay(lastTrimmedState);
  }
}

async function copyDisplayedState() {
  if (!lastStateJSON) {
    log("No state available to copy", "warning");
    return;
  }
  await copyToClipboard(lastStateJSON, "Displayed state");
}

async function copyPromptText() {
  if (!lastPromptText) {
    log("No prompt available to copy", "warning");
    return;
  }
  await copyToClipboard(lastPromptText, "Planner prompt");
}

async function init() {
  await loadSettings();
  applySettingsToInputs();

  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message) => {
      if (message && message.type === "CHATGPT_STATUS") {
        handleChatGPTStatus(message);
      }
    });
  }

  document.getElementById("save-settings").addEventListener("click", saveSettings);
  document.getElementById("refresh-health").addEventListener("click", () => refreshHealth());
  document.getElementById("snapshot-button").addEventListener("click", () => snapshotAction());
  document.getElementById("plan-only").addEventListener("click", () => planAction({ execute: false }));
  document.getElementById("plan-execute").addEventListener("click", () => planAction({ execute: true }));
  document
    .getElementById("refresh-state")
    .addEventListener("click", () => refreshState({ silent: false }));
  document.getElementById("quit-button").addEventListener("click", () => window.close());
  document.getElementById("full-state").addEventListener("change", onFullStateToggle);
  document.getElementById("copy-state").addEventListener("click", () => copyDisplayedState());
  document.getElementById("copy-plan").addEventListener("click", () => copyPromptText());

  document.getElementById("command-form").addEventListener("submit", sendCommand);
  document.getElementById("sequence-form").addEventListener("submit", sendSequence);
  document.getElementById("log-form").addEventListener("submit", sendLog);

  refreshHealth();
  refreshState({ silent: true }).catch(() => {
    // initial fetch failure already logged
  });
}

document.addEventListener("DOMContentLoaded", init);
