(function () {
  const candidateFinders = [
    () => document.querySelector("textarea[data-id]"),
    () => document.querySelector("textarea"),
    () => document.querySelector('[contenteditable="true"][data-testid="conversation-input"]'),
    () => document.querySelector('[contenteditable="true"][data-id]'),
    () => document.querySelector('[contenteditable="true"]'),
  ];

  function isVisible(el) {
    if (!el) {
      return false;
    }
    const style = window.getComputedStyle(el);
    return style && style.visibility !== "hidden" && style.display !== "none";
  }

  function findInput() {
    for (const finder of candidateFinders) {
      const candidate = finder();
      if (candidate) {
        console.debug("[ChatGPT Inject] Candidate input located", {
          tag: candidate.tagName,
          id: candidate.id,
          classes: candidate.className,
        });
      }
      if (candidate && isVisible(candidate)) {
        console.debug("[ChatGPT Inject] Using visible input candidate", {
          tag: candidate.tagName,
          id: candidate.id,
          classes: candidate.className,
        });
        return candidate;
      }
    }
    console.debug("[ChatGPT Inject] No visible input candidates found");
    return null;
  }

  function escapeHTML(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function applyValue(el, value) {
    if ("value" in el) {
      el.focus();
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    el.focus();
    el.innerHTML = escapeHTML(value).replace(/\n/g, "<br>");
    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      selection.addRange(range);
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function findSendButton() {
    const selectors = [
      'button[data-testid="send-button"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="submit"]',
    ];
    for (const selector of selectors) {
      const candidate = document.querySelector(selector);
      if (candidate) {
        console.debug("[ChatGPT Inject] Found send button candidate", {
          selector,
          tag: candidate.tagName,
          classes: candidate.className,
        });
        return candidate;
      }
    }
    console.debug("[ChatGPT Inject] No send button candidates found");
    return null;
  }

  async function dispatchPrompt(prompt) {
    console.debug("[ChatGPT Inject] Locating message input element");
    const input = findInput();
    if (!input) {
      console.error("[ChatGPT Inject] Unable to locate a usable input element");
      throw new Error("ChatGPT message box not found.");
    }
    applyValue(input, prompt);
    console.debug("[ChatGPT Inject] Prompt text applied; locating send button");
    const sendButton = findSendButton();
    if (!sendButton) {
      console.error("[ChatGPT Inject] Unable to locate send button after applying prompt");
      throw new Error("ChatGPT send button not found.");
    }
    console.debug("[ChatGPT Inject] Clicking send button");
    sendButton.click();
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== "SEND_PROMPT") {
      return false;
    }

    console.debug("[ChatGPT Inject] Received SEND_PROMPT message", {
      hasPrompt: typeof message.prompt === "string" && message.prompt.length > 0,
      sender,
    });
    const respond = (payload) => {
      try {
        console.debug("[ChatGPT Inject] Responding to popup", payload);
        sendResponse(payload);
      } catch (err) {
        console.error("Failed to send response", err);
      }
    };

    const ensureReady = () => {
      if (document.readyState === "complete" || document.readyState === "interactive") {
        console.debug("[ChatGPT Inject] Document already ready (", document.readyState, ")");
        return Promise.resolve();
      }
      console.debug("[ChatGPT Inject] Waiting for DOMContentLoaded before injecting prompt.");
      return new Promise((resolve) => {
        document.addEventListener("DOMContentLoaded", () => resolve(), { once: true });
      });
    };

    ensureReady()
      .then(() => {
        console.debug("[ChatGPT Inject] Dispatching prompt to UI");
        return dispatchPrompt(message.prompt || "");
      })
      .then(() => {
        console.debug("[ChatGPT Inject] Prompt dispatched successfully");
        respond({ ok: true });
      })
      .catch((error) => {
        const messageText = error && error.message ? error.message : String(error);
        console.error("[ChatGPT Inject] Failed to dispatch prompt", messageText);
        respond({ ok: false, error: messageText });
      });

    return true;
  });
})();
