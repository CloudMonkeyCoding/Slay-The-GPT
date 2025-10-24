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

  const assistantSelectors = [
    '[data-message-author-role="assistant"]',
    '[data-testid="conversation-turn"] [data-message-author-role="assistant"]',
    '[data-testid="conversation-turn"][data-role="assistant"]',
    '[data-testid="conversation-turn"] article',
    '[data-testid="assistant-message"]',
  ];

  function conversationRoot() {
    return (
      document.querySelector('[data-testid="conversation"]') ||
      document.querySelector('main div[data-testid="scroll-container"]') ||
      document.querySelector('main') ||
      document.body
    );
  }

  function collectAssistantNodes() {
    const seen = new Set();
    const nodes = [];
    for (const selector of assistantSelectors) {
      const found = document.querySelectorAll(selector);
      for (const node of found) {
        if (seen.has(node)) continue;
        seen.add(node);
        if (!isVisible(node)) continue;
        nodes.push(node);
      }
    }
    nodes.sort((a, b) => {
      if (a === b) return 0;
      const position = a.compareDocumentPosition(b);
      if (position & Node.DOCUMENT_POSITION_PRECEDING) {
        return 1;
      }
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
        return -1;
      }
      return 0;
    });
    return nodes;
  }

  function captureAssistantSnapshot() {
    const nodes = collectAssistantNodes();
    const count = nodes.length;
    const lastNode = count > 0 ? nodes[count - 1] : null;
    const lastText = lastNode ? (lastNode.textContent || "").trim() : "";
    return { count, lastText };
  }

  function isGenerating() {
    return !!(
      document.querySelector('button[data-testid="stop-button"]') ||
      document.querySelector('button[aria-label*="Stop"]')
    );
  }

  function notifyStatus(status, extra = {}) {
    try {
      chrome.runtime.sendMessage({ type: "CHATGPT_STATUS", status, ...extra });
    } catch (err) {
      // ignored
    }
  }

  function waitForAssistantResponse(initialSnapshot, options = {}) {
    const { timeoutMs = 180000, stableDurationMs = 600 } = options;
    return new Promise((resolve, reject) => {
      const start = Date.now();
      let lastCandidate = "";
      let stableSince = 0;
      let reportedStreaming = false;

      const root = conversationRoot();
      if (!root) {
        reject(new Error("ChatGPT conversation container not found."));
        return;
      }

      function cleanup() {
        observer.disconnect();
        clearInterval(intervalId);
      }

      function evaluate() {
        const snapshot = captureAssistantSnapshot();
        const newMessageDetected =
          snapshot.count > initialSnapshot.count ||
          (snapshot.count === initialSnapshot.count &&
            snapshot.lastText &&
            snapshot.lastText !== initialSnapshot.lastText);

        if (newMessageDetected && snapshot.lastText) {
          if (!reportedStreaming) {
            notifyStatus("response_streaming", {
              preview: snapshot.lastText.slice(0, 120),
            });
            reportedStreaming = true;
          }

          if (isGenerating()) {
            lastCandidate = snapshot.lastText;
            stableSince = 0;
          } else {
            if (snapshot.lastText !== lastCandidate) {
              lastCandidate = snapshot.lastText;
              stableSince = Date.now();
            } else if (!stableSince) {
              stableSince = Date.now();
            }

            if (stableSince && Date.now() - stableSince >= stableDurationMs) {
              cleanup();
              notifyStatus("response_ready", {
                length: snapshot.lastText.length,
              });
              resolve(snapshot.lastText);
              return;
            }
          }
        }

        if (Date.now() - start > timeoutMs) {
          cleanup();
          reject(new Error("Timed out waiting for ChatGPT response."));
        }
      }

      const observer = new MutationObserver(evaluate);
      observer.observe(root, {
        childList: true,
        subtree: true,
        characterData: true,
      });

      const intervalId = setInterval(evaluate, 300);
      evaluate();
    });
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
        notifyStatus("prompt_submitted");
        return;
      }
    }

    // Fallback when button not found or stays disabled
    const sent = await tryEnterToSend(input);
    if (sent) {
      notifyStatus("prompt_submitted");
      return;
    }

    // One last chance: look again (UI sometimes re-renders after input)
    await new Promise((r) => setTimeout(r, 300));
    sendButton = findSendButton();
    if (sendButton && buttonEnabled(sendButton)) {
      clickButton(sendButton);
      notifyStatus("prompt_submitted");
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

    let initialSnapshot = { count: 0, lastText: "" };

    ensureReady()
      .then(() => {
        initialSnapshot = captureAssistantSnapshot();
        return dispatchPrompt(message.prompt || "");
      })
      .then(() => {
        notifyStatus("waiting_for_response");
        return waitForAssistantResponse(initialSnapshot);
      })
      .then((replyText) => respond({ ok: true, responseText: replyText }))
      .catch((err) => {
        notifyStatus("response_error", { error: err?.message || String(err) });
        respond({ ok: false, error: err?.message || String(err) });
      });

    return true;
  });
})();
