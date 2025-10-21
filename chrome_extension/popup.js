const DEFAULT_HOST = "http://127.0.0.1:8123";
const STORAGE_DEFAULTS = {
  bridgeHost: DEFAULT_HOST,
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
let lastPromptText = "";

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

function isChatGPTUrl(url) {
  return /^https:\/\/chatgpt\.com(?:\/|$)/.test(url || "");
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

  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (activeTab && (isChatGPTUrl(activeTab.url) || isChatGPTUrl(activeTab.pendingUrl))) {
    return activeTab;
  }

  const activeTabs = await chrome.tabs.query({ active: true });
  for (const tab of activeTabs) {
    if (isChatGPTUrl(tab.url) || isChatGPTUrl(tab.pendingUrl)) {
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

  const candidates = await chrome.tabs.query({ url: ["https://chatgpt.com/*"] });
  if (candidates && candidates.length > 0) {
    candidates.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    const recent = candidates[0];
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
  throw new Error(`Could not find a chatgpt.com tab. ${details}`);
}

async function sendPromptToChatGPT(prompt) {
  if (typeof chrome === "undefined" || !chrome.tabs || !chrome.tabs.sendMessage) {
    throw new Error("Chrome tabs messaging API unavailable in this context.");
  }
  const tab = await getBestChatGPTTab();
  const response = await new Promise((resolve, reject) => {
    try {
      chrome.tabs.sendMessage(tab.id, { type: "SEND_PROMPT", prompt }, (reply) => {
        if (chrome.runtime && chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(reply);
      });
    } catch (err) {
      reject(err);
    }
  });
  if (response && response.ok) {
    return;
  }
  if (response && response.error) {
    throw new Error(response.error);
  }
  throw new Error("No response from ChatGPT content script. Reload the tab and try again.");
}

async function planAction({ execute }) {
  const planOutput = document.getElementById("plan-output");
  planOutput.textContent = "Preparing prompt...";
  try {
    const { trimmed } = await refreshState({ silent: true });
    if (!trimmed || Object.keys(trimmed).length === 0) {
      throw new Error("No state received before planning.");
    }
    const sendTrimmed = document.getElementById("trimmed-to-gpt").checked;
    settings.sendTrimmedState = sendTrimmed;
    let payload = trimmed;
    if (!sendTrimmed) {
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
    const prompt = buildPlannerPrompt(payload);
    setPromptDisplay(prompt);
    try {
      await sendPromptToChatGPT(prompt);
      log("Prompt sent to ChatGPT.", "success");
      if (execute) {
        log(
          "After ChatGPT replies with a sequence, paste it into Send Sequence to execute.",
          "info",
        );
      }
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
