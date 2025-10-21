(function () {
  const candidateFinders = [
    () => document.querySelector('textarea#prompt-textarea'),
    () => document.querySelector('textarea[aria-label*="message"]'),
    () => document.querySelector('textarea[data-id]'),
    () => document.querySelector('textarea'),
    () => document.querySelector('[contenteditable="true"][data-testid="conversation-input"]'),
    () => document.querySelector('[contenteditable="true"][data-id]'),
    () => document.querySelector('[contenteditable="true"]'),
  ];

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    return style && style.visibility !== "hidden" && style.display !== "none";
  }

  function findInput() {
    for (const finder of candidateFinders) {
      const candidate = finder();
      if (candidate && isVisible(candidate)) return candidate;
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

  function dispatch(el, type, init) {
    try {
      el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true, ...init }));
    } catch (e) {}
  }

  function keyEvent(el, type, opts = {}) {
    const ev = new KeyboardEvent(type, {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
      ...opts,
    });
    el.dispatchEvent(ev);
  }

  function dispatchInputEvents(el, value) {
    try {
      el.dispatchEvent(
        new InputEvent("beforeinput", {
          inputType: "insertFromPaste",
          data: value,
          bubbles: true,
          cancelable: true,
        }),
      );
    } catch {}
    try {
      el.dispatchEvent(
        new InputEvent("input", {
          inputType: "insertFromPaste",
          data: value,
          bubbles: true,
          cancelable: true,
        }),
      );
    } catch {
      dispatch(el, "input");
    }
    dispatch(el, "change");
  }

  function applyValue(el, value) {
    el.focus();

    if ("value" in el) {
      // textarea path
      el.value = value;
      dispatchInputEvents(el, value);
      // Some builds only enable the send button after keyup
      keyEvent(el, "keydown");
      keyEvent(el, "keyup");
      return;
    }

    // contenteditable path
    el.innerHTML = escapeHTML(value).replace(/\n/g, "<br>");
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.addRange(range);
    }
    dispatchInputEvents(el, value);
    keyEvent(el, "keydown");
    keyEvent(el, "keyup");
  }

  function buttonEnabled(button) {
    if (!button || button.disabled) return false;
    const ariaDisabled = button.getAttribute("aria-disabled");
    if (ariaDisabled && ariaDisabled.toLowerCase() !== "false") return false;
    const style = window.getComputedStyle(button);
    if (!style || style.visibility === "hidden" || style.display === "none" || style.pointerEvents === "none") {
      return false;
    }
    return true;
  }

  async function waitForButtonEnabled(button, timeoutMs = 4000) {
    if (!button) return false;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (buttonEnabled(button)) return true;
      await new Promise((r) => setTimeout(r, 120));
    }
    return buttonEnabled(button);
  }

  function clickButton(button) {
    // Simulate a real click
    const rect = button.getBoundingClientRect();
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      button: 0,
    };
    try {
      button.dispatchEvent(new PointerEvent("pointerdown", opts));
    } catch {}
    try {
      button.dispatchEvent(new MouseEvent("mousedown", opts));
    } catch {}
    try {
      button.dispatchEvent(new PointerEvent("pointerup", opts));
    } catch {}
    try {
      button.dispatchEvent(new MouseEvent("mouseup", opts));
    } catch {}
    button.click();
  }

  // 🔧 Expanded selectors to track UI changes
  function findSendButton() {
    const selectors = [
      'button[data-testid="send-button"]',
      'button[aria-label="Send message"]',
      'button[aria-label*="Send"]',
      'form button[type="submit"]',
      // Chrome supports :has now; parent button containing a Send icon
      'button:has(svg[aria-label="Send"])',
      'button:has(svg[aria-label*="Send"])',
    ];
    for (const sel of selectors) {
      const btn = document.querySelector(sel);
      if (btn) return btn;
    }
    return null;
  }

  function nearestForm(el) {
    return el.closest("form") || document.querySelector('form[aria-label*="input"], form');
  }

  // ✅ Fallback: press Enter in the input or submit the form
  async function tryEnterToSend(input) {
    try {
      input.focus();
      keyEvent(input, "keydown");
      keyEvent(input, "keypress");
      keyEvent(input, "keyup");
      // Also try submitting the form if present
      const form = nearestForm(input);
      if (form) {
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      }
      return true;
    } catch {
      return false;
    }
  }

  async function dispatchPrompt(prompt) {
    const input = findInput();
    if (!input) throw new Error("ChatGPT message box not found.");

    applyValue(input, prompt);

    // Wait briefly so ChatGPT's UI has time to enable the send control after paste
    await new Promise((r) => setTimeout(r, 250));

    let sendButton = findSendButton();
    if (sendButton) {
      const ok = await waitForButtonEnabled(sendButton, 4000);
      if (ok) {
        clickButton(sendButton);
        return;
      }
    }

    // Fallback when button not found or stays disabled
    const sent = await tryEnterToSend(input);
    if (sent) return;

    // One last chance: look again (UI sometimes re-renders after input)
    await new Promise((r) => setTimeout(r, 300));
    sendButton = findSendButton();
    if (sendButton && buttonEnabled(sendButton)) {
      clickButton(sendButton);
      return;
    }

    throw new Error("ChatGPT send button not found.");
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === "PING") {
      sendResponse({ ok: true });
      return false;
    }
    if (!message || message.type !== "SEND_PROMPT") return false;

    const respond = (payload) => {
      try {
        sendResponse(payload);
      } catch {}
    };

    const ensureReady = () => {
      if (document.readyState === "complete" || document.readyState === "interactive") return Promise.resolve();
      return new Promise((res) => document.addEventListener("DOMContentLoaded", () => res(), { once: true }));
    };

    ensureReady()
      .then(() => dispatchPrompt(message.prompt || ""))
      .then(() => respond({ ok: true }))
      .catch((err) => respond({ ok: false, error: err?.message || String(err) }));

    return true;
  });
})();
