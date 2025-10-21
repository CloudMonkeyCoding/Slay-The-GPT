"""
Bridge between Slay the Spire CommunicationMod and a Chrome extension.

This module exposes a lightweight HTTP server that allows a browser extension to
fetch game state snapshots and submit action sequences for execution.  The
extension can use these endpoints to funnel data to/from ChatGPT while this
process continues to talk to the CommunicationMod via stdin/stdout (the same
protocol used by ai_controller_hardcoded_key.py).

Endpoints
---------
GET  /health            -> {"status": "ok"}
GET  /state             -> latest trimmed state (forces refresh)
GET  /state?full=1      -> raw CommunicationMod state envelope
POST /command           -> {"command": "key", "args": {...}}
POST /sequence          -> {"steps": [...]} executes sequentially
POST /log               -> {"message": "..."} appends to log window (optional)

All responses include CORS headers so the Chrome extension can call them.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Dict, List, Optional, Tuple

HOST = os.environ.get("CHROME_BRIDGE_HOST", "127.0.0.1")
PORT = int(os.environ.get("CHROME_BRIDGE_PORT", "8123"))

PAUSE_MS_AFTER_KEY = 150
PAUSE_MS_AFTER_CLICK = 120


def log(msg: str) -> None:
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()


def send(cmd: str) -> None:
    log(f"[send] -> {cmd}")
    sys.stdout.write(cmd + "\n")
    sys.stdout.flush()


def read_line() -> Optional[str]:
    for line in sys.stdin:
        line = line.rstrip("\r\n")
        if line:
            return line
    return None


def wait_ms(ms: int) -> None:
    time.sleep(ms / 1000.0)


# ---- State helpers -------------------------------------------------------


def prune_empty(x: Any) -> Any:
    if isinstance(x, dict):
        y = {k: prune_empty(v) for k, v in x.items()}
        return {k: v for k, v in y.items() if v not in (None, {}, [], "")}
    if isinstance(x, list):
        y = [prune_empty(v) for v in x]
        return [v for v in y if v not in (None, {}, [], "")]
    return x


REWARD_KEYS = {"rewards", "cards", "relic", "gold_gain", "choice_list", "screen_state", "room_type"}
SHOP_KEYS = {"shop", "removals_left", "prices", "choice_list", "screen_state", "room_type"}
CHEST_KEYS = {"chest_type", "relics", "can_open", "choice_list", "screen_state", "room_type"}
CAMPFIRE_KEYS = {"options", "choice_list", "screen_state", "room_type"}
EVENT_KEYS = {"screen_state", "choice_list", "room_type"}
MAP_KEYS = {"map", "path", "choice_list", "screen_state", "room_type"}
GAMEOVER_KEYS = {"score", "killed_by", "floor_reached", "choice_list", "screen_state", "room_type"}
COMMON_KEEP = {"choice_list", "screen_state", "room_type"}


def relic_names(relics: Optional[List[Dict[str, Any]]]) -> List[str]:
    out: List[str] = []
    for relic in relics or []:
        name = relic.get("name") or relic.get("id")
        if name and name != "Potion Slot":
            out.append(name)
    return out


def in_combat_like(gs: Dict[str, Any]) -> bool:
    st = (gs.get("screen_type") or "").upper()
    if st == "COMBAT":
        return True
    rp = (gs.get("room_phase") or "").upper()
    if rp == "COMBAT":
        return True
    ap = (gs.get("action_phase") or "").upper()
    if ap and ap not in ("WAITING_ON_USER", "", None):
        return True
    return False


def filter_noncombat_view(screen_type: Optional[str], gs: Dict[str, Any]) -> Dict[str, Any]:
    st = (screen_type or "").upper()
    if st in ("CARD_REWARD", "BOSS_REWARD", "CHEST_REWARD", "REWARD"):
        keep = REWARD_KEYS
    elif st == "SHOP":
        keep = SHOP_KEYS
    elif st in ("CHEST", "TREASURE"):
        keep = CHEST_KEYS
    elif st in ("REST", "CAMPFIRE"):
        keep = CAMPFIRE_KEYS
    elif st == "EVENT":
        keep = EVENT_KEYS
    elif st == "MAP":
        keep = MAP_KEYS
    elif st in ("GAME_OVER", "DEATH"):
        keep = GAMEOVER_KEYS
    else:
        keep = COMMON_KEEP
    view = {k: gs[k] for k in keep if k in gs}
    if st != "MAP":
        view.pop("map", None)
    return prune_empty(view)


def make_trimmed_snapshot(envelope: Dict[str, Any]) -> Dict[str, Any]:
    gs = envelope.get("game_state", {}) or {}
    st = gs.get("screen_type")
    if in_combat_like(gs):
        full = dict(gs)
        full.pop("map", None)
        return {
            "ready_for_command": envelope.get("ready_for_command"),
            "in_game": envelope.get("in_game"),
            "screen_type": st,
            "game_state": prune_empty(full),
        }
    header = {
        "class": gs.get("class"),
        "ascension": gs.get("ascension_level"),
        "act": gs.get("act"),
        "floor": gs.get("floor"),
        "hp": {"current": gs.get("current_hp"), "max": gs.get("max_hp")},
        "gold": gs.get("gold"),
        "relics": relic_names(gs.get("relics")),
        "potions": [p.get("name") for p in (gs.get("potions") or []) if p.get("name") != "Potion Slot"],
    }
    view = filter_noncombat_view(st, gs)
    return {
        "ready_for_command": envelope.get("ready_for_command"),
        "in_game": envelope.get("in_game"),
        "screen_type": st,
        "header": prune_empty(header),
        "view": view,
    }


# ---- Execution helpers ---------------------------------------------------


def hand_index_for_uuid(gs: Dict[str, Any], uuid: str) -> Optional[int]:
    hand = gs.get("hand")
    if hand is None:
        hand = gs.get("game_state", {}).get("hand")
    if not hand:
        return None
    for idx, card in enumerate(hand):
        if card.get("uuid") == uuid:
            return idx
    return None


def execute_step(step: Dict[str, Any]) -> None:
    cmd = (step.get("command") or "").lower()
    args = step.get("args") or {}

    log(f"Executing step: command={cmd}, args={args}")

    if cmd == "wait":
        wait_ms(int(args.get("ms", 100)))
        return
    if cmd == "state":
        send("state")
        _ = read_line()
        return
    if cmd == "key":
        key = args.get("key")
        if not key:
            log("[execute] missing key value")
            return
        send(f"key {key}")
        wait_ms(args.get("pause_ms", PAUSE_MS_AFTER_KEY))
        return
    if cmd == "click":
        x = args.get("x")
        y = args.get("y")
        if x is None or y is None:
            log("[execute] click missing coordinates")
            return
        send(f"click {x} {y}")
        wait_ms(args.get("pause_ms", PAUSE_MS_AFTER_CLICK))
        return
    if cmd == "card":
        uuid = args.get("uuid")
        if not uuid:
            log("[execute] card command missing uuid")
            return
        state = controller.get_state(full=True)
        if not state:
            log("[execute] unable to fetch state for card command")
            return
        gs = state.get("game_state") or {}
        idx = hand_index_for_uuid(gs, uuid)
        if idx is None:
            log(f"[execute] uuid {uuid} not found in hand")
            return
        # CommunicationMod expects number keys (1-based) to select cards in hand.
        send(f"key {idx + 1}")
        wait_ms(args.get("pause_ms", PAUSE_MS_AFTER_KEY))
        return

    log(f"[execute] unknown command '{cmd}'")


# ---- Controller ----------------------------------------------------------

class ChromeExtensionController:
    def __init__(self) -> None:
        self._state_lock = threading.Lock()
        self._latest_raw: Optional[Dict[str, Any]] = None
        self._latest_trimmed: Optional[Dict[str, Any]] = None

    def refresh_state(self) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
        log("Requesting state from CommunicationMod via Chrome bridge...")
        send("state")
        raw_line = read_line()
        if not raw_line:
            log("[state] No response received from CommunicationMod")
            return None, None
        try:
            envelope = json.loads(raw_line)
        except Exception as exc:  # pragma: no cover (debug path)
            log(f"[state] Failed to parse JSON: {exc}")
            return None, None
        trimmed = make_trimmed_snapshot(envelope)
        with self._state_lock:
            self._latest_raw = envelope
            self._latest_trimmed = trimmed
        return envelope, trimmed

    def get_state(self, *, full: bool = False, refresh: bool = True) -> Optional[Dict[str, Any]]:
        if refresh:
            envelope, trimmed = self.refresh_state()
            if not envelope:
                return None
            return envelope if full else trimmed
        with self._state_lock:
            cached = self._latest_raw if full else self._latest_trimmed
        if cached is not None:
            return cached
        return self.get_state(full=full, refresh=True)

    def execute_sequence(self, steps: List[Dict[str, Any]]) -> Dict[str, Any]:
        results: List[str] = []
        for step in steps:
            try:
                execute_step(step)
                results.append("ok")
            except Exception as exc:  # pragma: no cover (debug path)
                msg = f"error: {exc}"
                log(f"[sequence] {msg}")
                results.append(msg)
        return {"results": results}


controller = ChromeExtensionController()


# ---- HTTP server ---------------------------------------------------------

class ThreadedHTTPServer(HTTPServer):
    daemon_threads = True


class ChromeBridgeHandler(BaseHTTPRequestHandler):
    server_version = "ChromeBridge/1.0"

    def _set_headers(self, status: HTTPStatus = HTTPStatus.OK, content_type: str = "application/json") -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_OPTIONS(self) -> None:  # noqa: N802
        self._set_headers(HTTPStatus.NO_CONTENT)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.startswith("/health"):
            self._set_headers()
            self.wfile.write(b"{\"status\": \"ok\"}")
            return
        if self.path.startswith("/state"):
            full = "full=1" in self.path or "full=true" in self.path.lower()
            state = controller.get_state(full=full)
            if state is None:
                self._set_headers(HTTPStatus.BAD_GATEWAY)
                self.wfile.write(b"{\"error\": \"no_state\"}")
                return
            body = json.dumps(state).encode("utf-8")
            self._set_headers()
            self.wfile.write(body)
            return
        self._set_headers(HTTPStatus.NOT_FOUND)
        self.wfile.write(b"{\"error\": \"not_found\"}")

    def _read_json(self) -> Optional[Dict[str, Any]]:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return None
        try:
            data = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            return None
        return data

    def do_POST(self) -> None:  # noqa: N802
        if self.path.startswith("/command"):
            payload = self._read_json() or {}
            cmd = payload.get("command")
            if not cmd:
                self._set_headers(HTTPStatus.BAD_REQUEST)
                self.wfile.write(b"{\"error\": \"missing_command\"}")
                return
            args = payload.get("args") or {}
            execute_step({"command": cmd, "args": args})
            self._set_headers()
            self.wfile.write(b"{\"status\": \"sent\"}")
            return
        if self.path.startswith("/sequence"):
            payload = self._read_json() or {}
            steps = payload.get("steps")
            if not isinstance(steps, list):
                self._set_headers(HTTPStatus.BAD_REQUEST)
                self.wfile.write(b"{\"error\": \"invalid_steps\"}")
                return
            result = controller.execute_sequence(steps)
            self._set_headers()
            self.wfile.write(json.dumps(result).encode("utf-8"))
            return
        if self.path.startswith("/log"):
            payload = self._read_json() or {}
            message = payload.get("message")
            if message:
                log(f"[extension] {message}")
            self._set_headers()
            self.wfile.write(b"{\"status\": \"ok\"}")
            return
        self._set_headers(HTTPStatus.NOT_FOUND)
        self.wfile.write(b"{\"error\": \"not_found\"}")


# ---- Entrypoint ----------------------------------------------------------


def run_server() -> None:
    log(f"Starting Chrome bridge server on http://{HOST}:{PORT}")
    server = ThreadedHTTPServer((HOST, PORT), ChromeBridgeHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:  # pragma: no cover
        pass
    finally:
        server.server_close()
        log("Chrome bridge server stopped")


if __name__ == "__main__":
    # Handshake so CommunicationMod connects
    sys.stdout.write("ready\n")
    sys.stdout.flush()
    run_server()
