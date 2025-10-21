# Slay the GPT Chrome Extension

This extension offers a lightweight interface for the `chrome_extension_bridge.py`
process so you can inspect the current Slay the Spire game state, capture
snapshots, and drive the same "Plan / Snapshot / Plan + Execute" workflow that
the original `ai_controller_hardcoded_key.py` GUI exposed.

## Features

- Health indicator for the local bridge server
- Snapshot button that fetches a trimmed state, mirrors it in the UI, and copies
  it to the clipboard for quick sharing with GPT
- Plan only / Plan + Execute buttons that call OpenAI's APIs with the trimmed or
  full snapshot (user configurable) and optionally submit the resulting
  sequence back to the bridge
- Toggle between trimmed and full CommunicationMod state snapshots for display
- Forms to send single commands, action sequences, and log messages
- Configurable bridge URL and OpenAI credentials persisted with Chrome
  sync/local storage

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
address or port. Supply your OpenAI API key and preferred model (defaults to
`gpt-5`) in the planner controls, then click **Save Settings**.

## Usage tips

- The **Snapshot** button mirrors the Tkinter GUI behaviour: it always requests
  a fresh trimmed snapshot from the bridge, updates the display, and copies the
  JSON to your clipboard. Use the "Display full envelope" checkbox if you want
  to view the full CommunicationMod payload without affecting what is sent to
  GPT.
- **Plan only** and **Plan + Execute** will re-use the trimmed snapshot unless
  you uncheck "Send trimmed snapshot to GPT", in which case the extension grabs
  the cached full envelope before contacting OpenAI. Both buttons surface the
  model's response in the "Last Plan" panel and the latter also posts the
  sequence back to `/sequence` on the bridge.
- The manual command/sequence/log forms remain available below if you need to
  issue ad-hoc actions outside the automated workflow.
