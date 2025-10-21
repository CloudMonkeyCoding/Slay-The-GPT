const DEFAULT_HOST = "http://127.0.0.1:8123";
let bridgeHost = DEFAULT_HOST;

function storageAvailable() {
  return typeof chrome !== "undefined" && !!(chrome.storage && chrome.storage.local);
}

async function loadBridgeHost() {
  if (!storageAvailable()) {
    bridgeHost = DEFAULT_HOST;
    return bridgeHost;
  }
  return new Promise((resolve) => {
    chrome.storage.local.get({ bridgeHost: DEFAULT_HOST }, (items) => {
      bridgeHost = items.bridgeHost || DEFAULT_HOST;
      resolve(bridgeHost);
    });
  });
}

async function persistBridgeHost(host) {
  bridgeHost = host || DEFAULT_HOST;
  if (!storageAvailable()) {
    return;
  }
  return new Promise((resolve) => {
    chrome.storage.local.set({ bridgeHost }, resolve);
  });
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

async function fetchJSON(path, options = {}) {
  const url = `${bridgeHost}${path}`;
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

async function refreshState() {
  const output = document.getElementById("state-output");
  const full = document.getElementById("full-state").checked;
  output.textContent = "Loading...";
  try {
    const data = await fetchJSON(full ? "/state?full=1" : "/state");
    output.textContent = JSON.stringify(data, null, 2);
    log("Fetched state", "success");
  } catch (err) {
    output.textContent = "Error fetching state";
    log(`State fetch failed: ${err.message}`, "error");
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

async function init() {
  await loadBridgeHost();

  const hostInput = document.getElementById("host-input");
  hostInput.value = bridgeHost;

  document
    .getElementById("refresh-health")
    .addEventListener("click", () => refreshHealth());
  document
    .getElementById("refresh-state")
    .addEventListener("click", () => refreshState());
  document.getElementById("save-host").addEventListener("click", async () => {
    const value = hostInput.value.trim() || DEFAULT_HOST;
    try {
      new URL(value);
    } catch (err) {
      log(`Invalid URL: ${value}`, "error");
      hostInput.focus();
      return;
    }
    await persistBridgeHost(value.replace(/\/$/, ""));
    hostInput.value = bridgeHost;
    log(`Bridge URL set to ${bridgeHost}`, "success");
  });
  document
    .getElementById("command-form")
    .addEventListener("submit", sendCommand);
  document
    .getElementById("sequence-form")
    .addEventListener("submit", sendSequence);
  document.getElementById("log-form").addEventListener("submit", sendLog);

  refreshHealth();
  refreshState();
}

document.addEventListener("DOMContentLoaded", init);
