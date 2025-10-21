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
      if (candidate && isVisible(candidate)) {
        return candidate;
      }
    }
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
    return (
      document.querySelector('button[data-testid="send-button"]') ||
      document.querySelector('button[aria-label*="Send"]') ||
      document.querySelector('button[aria-label*="submit"]')
    );
  }

  async function dispatchPrompt(prompt) {
    const input = findInput();
    if (!input) {
      throw new Error("ChatGPT message box not found.");
    }
    applyValue(input, prompt);
    const sendButton = findSendButton();
    if (!sendButton) {
      throw new Error("ChatGPT send button not found.");
    }
    sendButton.click();
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== "SEND_PROMPT") {
      return false;
    }

    const respond = (payload) => {
      try {
        sendResponse(payload);
      } catch (err) {
        console.error("Failed to send response", err);
      }
    };

    const ensureReady = () => {
      if (document.readyState === "complete" || document.readyState === "interactive") {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        document.addEventListener("DOMContentLoaded", () => resolve(), { once: true });
      });
    };

    ensureReady()
      .then(() => dispatchPrompt(message.prompt || ""))
      .then(() => respond({ ok: true }))
      .catch((error) => respond({ ok: false, error: error && error.message ? error.message : String(error) }));

    return true;
  });
})();
