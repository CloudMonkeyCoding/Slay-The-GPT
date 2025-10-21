# Slay the GPT Chrome Extension

This extension offers a lightweight interface for the `chrome_extension_bridge.py`
process so you can inspect the current Slay the Spire game state, capture
snapshots, and drive the same "Plan / Snapshot / Plan + Execute" workflow that
the original `ai_controller_hardcoded_key.py` GUI exposed.

## Features

- Health indicator for the local bridge server
- Snapshot button that fetches a trimmed state, mirrors it in the UI, and copies
  it to the clipboard for quick sharing with GPT
- Plan only / Plan + Execute buttons that build a planner prompt and send it to
  the active chat.openai.com tab on your behalf
- Toggle between trimmed and full CommunicationMod state snapshots for display
- Forms to send single commands, action sequences, and log messages
- Configurable bridge URL and trimmed/full snapshot preference persisted with
  Chrome sync/local storage

## Installation

1. Run `chrome_extension_bridge.py` (or any controller exposing the same
   endpoints) and make sure it prints `ready` for the CommunicationMod
   handshake.
2. Open Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** in the top-right corner.
4. Choose **Load unpacked**, then select this repository's
   `chrome_extension/` directory.
5. Click the "Slay the GPT Bridge" toolbar icon to open the popup.

Adjust the bridge URL in the popup if the server is hosted on a different
address or port. The planner now talks directly to ChatGPT through the active
browser tab, so no API key or model selection is required.

## Usage tips

- The **Snapshot** button mirrors the Tkinter GUI behaviour: it always requests
  a fresh trimmed snapshot from the bridge, updates the display, and copies the
  JSON to your clipboard. Use the "Display full envelope" checkbox if you want
  to view the full CommunicationMod payload without affecting what is sent to
  GPT.
- Before planning, open chat.openai.com in the current tab and place the cursor
  in the conversation you want to use. The extension validates the active tab
  and will log a warning if it cannot reach the ChatGPT UI automatically.
- If you see a warning about the ChatGPT content script, reload the
  chat.openai.com tab (or open a new conversation) so Chrome reinjects the
  helper before retrying.
- **Plan only** and **Plan + Execute** reuse the trimmed snapshot unless you
  uncheck "Send trimmed snapshot to ChatGPT", in which case the extension grabs
  the cached full envelope before composing the message. The generated prompt is
  shown in the "Last Prompt" panel and automatically submitted in the active
  ChatGPT tab. **Plan + Execute** reminds you to paste ChatGPT's JSON response
  into the Send Sequence form once it arrives.
- The manual command/sequence/log forms remain available below if you need to
  issue ad-hoc actions outside the automated workflow.
