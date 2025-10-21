const DEFAULT_HOST = "http://127.0.0.1:8123";
const DEFAULT_MODEL = "gpt-5";

const STORAGE_DEFAULTS = {
  bridgeHost: DEFAULT_HOST,
  openaiApiKey: "",
  openaiModel: DEFAULT_MODEL,
  sendTrimmedState: true,
};

const SYSTEM_INSTRUCTIONS = `You are an expert Slay the Spire planner that outputs an action SEQUENCE.
Rules:
- Return ONLY JSON that matches the provided schema.
- Prefer native commands: key, click, choose, wait, state.
- You MAY use convenience commands 'play' with {"uuid":"..."} and 'end' with {}.
- If a card needs a target, include args.click {x,y} or skip the play.
- Keep sequences short (<=5 steps). No prose, no extra fields.`;

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

let settings = { ...STORAGE_DEFAULTS };
let lastTrimmedState = null;
let lastFullState = null;
let lastStateJSON = "";
let lastPlanJSON = "";

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
        openaiApiKey: items.openaiApiKey || "",
        openaiModel: items.openaiModel || DEFAULT_MODEL,
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
        openaiApiKey: settings.openaiApiKey,
        openaiModel: settings.openaiModel,
        sendTrimmedState: settings.sendTrimmedState,
      },
      resolve,
    );
  });
}

function applySettingsToInputs() {
  const hostInput = document.getElementById("host-input");
  const apiKeyInput = document.getElementById("api-key");
  const modelInput = document.getElementById("model-name");
  const trimmedCheckbox = document.getElementById("trimmed-to-gpt");

  hostInput.value = settings.bridgeHost;
  apiKeyInput.value = settings.openaiApiKey;
  modelInput.value = settings.openaiModel;
  trimmedCheckbox.checked = settings.sendTrimmedState;
}

function readPlannerConfigFromInputs() {
  const apiKey = document.getElementById("api-key").value.trim() || settings.openaiApiKey;
  const model = document.getElementById("model-name").value.trim() || settings.openaiModel;
  const sendTrimmed = document.getElementById("trimmed-to-gpt").checked;
  return { apiKey, model, sendTrimmed };
}

function readSettingsFromInputs() {
  const hostValue = (document.getElementById("host-input").value || "").trim() || DEFAULT_HOST;
  const apiKey = document.getElementById("api-key").value.trim();
  const model = document.getElementById("model-name").value.trim() || DEFAULT_MODEL;
  const sendTrimmed = document.getElementById("trimmed-to-gpt").checked;
  return {
    bridgeHost: hostValue.replace(/\/$/, ""),
    openaiApiKey: apiKey,
    openaiModel: model,
    sendTrimmedState: sendTrimmed,
  };
}

function log(message, type = "info") {
  const consoleEl = document.getElementById("console-output");
  const timestamp = new Date().toLocaleTimeString();
  consoleEl.textContent = `[${timestamp}] (${type}) ${message}\n` + consoleEl.textContent;
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

function setPlanDisplay(sequence) {
  const output = document.getElementById("plan-output");
  if (!sequence) {
    lastPlanJSON = "";
    output.textContent = "";
    return;
  }
  lastPlanJSON = JSON.stringify({ sequence }, null, 2);
  output.textContent = lastPlanJSON;
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
  const output = document.getElementById("state-output");
  output.textContent = "Loading...";
  try {
    const trimmed = await fetchState({ full: false, refresh: true });
    lastTrimmedState = trimmed;
    let displayState = trimmed;
    if (wantFull) {
      try {
        const fullState = await fetchState({ full: true, refresh: false });
        lastFullState = fullState;
        displayState = fullState;
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
    }
    return { trimmed, displayState };
  } catch (err) {
    output.textContent = "Error fetching state";
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

function extractSequenceFromText(text) {
  if (!text) {
    return [];
  }
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (parsed && Array.isArray(parsed.sequence)) {
      return parsed.sequence;
    }
  } catch (err) {
    // fall through to empty
  }
  return [];
}

function sanitizeSequence(sequence) {
  if (!Array.isArray(sequence)) {
    return [];
  }
  return sequence
    .filter((step) => step && typeof step === "object" && typeof step.command === "string")
    .map((step) => ({
      command: step.command,
      args:
        step.args && typeof step.args === "object" && !Array.isArray(step.args) ? step.args : {},
    }));
}

async function callResponsesAPI(payload, config) {
  log(`Planning with Responses API using model ${config.model}`, "info");
  const body = {
    model: config.model,
    response_format: { type: "json_schema", json_schema: ACTION_SCHEMA },
    input: [
      { role: "system", content: SYSTEM_INSTRUCTIONS },
      {
        role: "user",
        content: `Current run state JSON:\n${JSON.stringify(payload)}\nReturn only the sequence object that matches the schema.`,
      },
    ],
    max_output_tokens: 800,
  };
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Responses API error ${res.status}: ${detail}`);
  }
  const data = await res.json();
  const parsed = data?.output?.[0]?.content?.[0]?.parsed;
  if (parsed && Array.isArray(parsed.sequence)) {
    return parsed.sequence;
  }
  const text = data.output_text || data?.output?.[0]?.content?.[0]?.text || "";
  const seq = extractSequenceFromText(text);
  if (seq.length) {
    return seq;
  }
  throw new Error("Responses API returned no parsable sequence.");
}

async function callChatCompletionsAPI(payload, config) {
  log(`Falling back to Chat Completions with model ${config.model}`, "warning");
  const body = {
    model: config.model,
    response_format: { type: "json_object" },
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          SYSTEM_INSTRUCTIONS +
          "\nReturn ONLY a JSON object of the form {\"sequence\": [...]}.",
      },
      {
        role: "user",
        content: `Current run state JSON:\n${JSON.stringify(payload)}\nReturn only the sequence object that matches the schema.`,
      },
    ],
    max_tokens: 800,
  };
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Chat Completions error ${res.status}: ${detail}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || "";
  const parsed = extractSequenceFromText(content);
  if (Array.isArray(parsed)) {
    return parsed;
  }
  throw new Error("Chat Completions returned no parsable sequence.");
}

async function requestPlan(payload) {
  const config = readPlannerConfigFromInputs();
  if (!config.apiKey) {
    throw new Error("OpenAI API key required. Save it in the planner controls.");
  }
  config.model = config.model || DEFAULT_MODEL;
  settings.openaiApiKey = config.apiKey;
  settings.openaiModel = config.model;
  settings.sendTrimmedState = config.sendTrimmed;
  let sequence;
  try {
    sequence = await callResponsesAPI(payload, config);
  } catch (err) {
    log(err.message, "warning");
    sequence = await callChatCompletionsAPI(payload, config);
  }
  return sanitizeSequence(sequence);
}

async function planAction({ execute }) {
  const planOutput = document.getElementById("plan-output");
  planOutput.textContent = "Planning...";
  try {
    const { trimmed } = await refreshState({ silent: true });
    if (!trimmed || Object.keys(trimmed).length === 0) {
      throw new Error("No state received before planning.");
    }
    const config = readPlannerConfigFromInputs();
    let payload = trimmed;
    if (!config.sendTrimmed) {
      try {
        const fullState = await fetchState({ full: true, refresh: false });
        lastFullState = fullState;
        if (stateDisplayPreference()) {
          setStateDisplay(fullState);
        }
        payload = fullState;
      } catch (err) {
        throw new Error(`Failed to fetch full state: ${err.message}`);
      }
    }
    const sequence = await requestPlan(payload);
    setPlanDisplay(sequence);
    if (!sequence.length) {
      log("Planner returned no steps.", "warning");
      return;
    }
    if (execute) {
      const resp = await fetchJSON("/sequence", {
        method: "POST",
        body: JSON.stringify({ steps: sequence }),
      });
      log(`Sequence executed: ${JSON.stringify(resp)}`, "success");
    } else {
      log("Plan ready (not executed).", "success");
    }
  } catch (err) {
    planOutput.textContent = "Planning failed.";
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

async function sendSequence(event) {
  event.preventDefault();
  const field = document.getElementById("sequence-steps");
  let steps = [];
  try {
    steps = parseJSONField(field.value, []);
    if (!Array.isArray(steps)) {
      throw new Error("Sequence must be a JSON array");
    }
  } catch (err) {
    log(err.message, "error");
    field.focus();
    return;
  }
  try {
    const resp = await fetchJSON("/sequence", {
      method: "POST",
      body: JSON.stringify({ steps }),
    });
    log(`Sequence sent: ${JSON.stringify(resp)}`, "success");
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

async function copyPlanJSON() {
  if (!lastPlanJSON) {
    log("No plan available to copy", "warning");
    return;
  }
  await copyToClipboard(lastPlanJSON, "Plan JSON");
}

async function init() {
  await loadSettings();
  applySettingsToInputs();

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
  document.getElementById("copy-plan").addEventListener("click", () => copyPlanJSON());

  document.getElementById("command-form").addEventListener("submit", sendCommand);
  document.getElementById("sequence-form").addEventListener("submit", sendSequence);
  document.getElementById("log-form").addEventListener("submit", sendLog);

  refreshHealth();
  refreshState({ silent: true }).catch(() => {
    // initial fetch failure already logged
  });
}

document.addEventListener("DOMContentLoaded", init);
