# Slay the GPT Chrome Extension

This extension offers a lightweight interface for the `chrome_extension_bridge.py`
process so you can inspect the current Slay the Spire game state and send
commands without leaving your browser.

## Features

- Health indicator for the local bridge server
- Toggle between trimmed and full CommunicationMod state snapshots
- Forms to send single commands, action sequences, and log messages
- Configurable bridge URL persisted with Chrome sync/local storage

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
address or port.
