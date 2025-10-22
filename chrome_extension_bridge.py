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
from typing import Any, Dict, List, Optional, Set, Tuple
from urllib.parse import parse_qs, urlparse

HOST = os.environ.get("CHROME_BRIDGE_HOST", "127.0.0.1")
PORT = int(os.environ.get("CHROME_BRIDGE_PORT", "8123"))

PAUSE_MS_AFTER_KEY = 150
PAUSE_MS_AFTER_CLICK = 120


CARD_INDEX_KEYS = (
    "index",
    "value",
    "card",
    "slot",
    "hand_index",
    "card_index",
    "cardIndex",
    "handIndex",
    "position",
    "pos",
    "card_slot",
    "cardSlot",
    "slot_index",
    "slotIndex",
    "card_position",
    "cardPosition",
)

ZERO_BASED_CARD_KEYS = {
    "hand_index",
    "handindex",
    "hand_position",
    "handposition",
    "position",
    "pos",
    "card_slot",
    "cardslot",
    "slot",
    "slot_index",
    "slotindex",
    "card_position",
    "cardposition",
}

CARD_UUID_KEYS = ("uuid", "card_uuid", "cardUuid", "cardUUID")
CARD_ID_KEYS = ("card_id", "cardId", "id")
CARD_NAME_KEYS = ("card_name", "cardName", "name", "label", "display")

HAND_LIST_KEYS = (
    "hand",
    "player_hand",
    "playerHand",
    "hand_cards",
    "handCards",
    "cards_in_hand",
    "cardsInHand",
    "cards",
)


CARD_KEY_ALIASES = {
    **{str(i): f"CARD_{i}" for i in range(1, 11)},
    **{f"CARD_{i}": f"CARD_{i}" for i in range(1, 11)},
    "0": "CARD_10",
}

SPECIAL_KEY_ALIASES = {
    "E": "END_TURN",
    "END": "END_TURN",
    "ENDTURN": "END_TURN",
    "SPACE": "END_TURN",
    "SPACEBAR": "END_TURN",
    "ENTER": "CONFIRM",
    "RETURN": "CONFIRM",
    "CONFIRM": "CONFIRM",
    "CANCEL": "CANCEL",
    "ESC": "CANCEL",
    "ESCAPE": "CANCEL",
    "LEFT": "LEFT",
    "RIGHT": "RIGHT",
    "UP": "UP",
    "DOWN": "DOWN",
    "MAP": "MAP",
    "DECK": "DECK",
    "DRAW_PILE": "DRAW_PILE",
    "DISCARD_PILE": "DISCARD_PILE",
    "EXHAUST_PILE": "EXHAUST_PILE",
    "DROP_CARD": "DROP_CARD",
}


MONSTER_INDEX_KEYS = (
    "monster_index",
    "monsterIndex",
    "target_index",
    "targetIndex",
    "enemy_index",
    "enemyIndex",
    "monster_slot",
    "monsterSlot",
    "enemy_slot",
    "enemySlot",
    "target_slot",
    "targetSlot",
    "monster_position",
    "monsterPosition",
    "enemy_position",
    "enemyPosition",
    "target_position",
    "targetPosition",
    "position",
    "pos",
    "slot",
)

MONSTER_DIRECT_KEYS = ("monster", "enemy", "target")

ZERO_BASED_MONSTER_KEYS = {
    "monster_slot",
    "monsterslot",
    "enemy_slot",
    "enemyslot",
    "target_slot",
    "targetslot",
    "monster_position",
    "monsterposition",
    "enemy_position",
    "enemyposition",
    "target_position",
    "targetposition",
    "position",
    "pos",
    "slot",
}

MONSTER_UUID_KEYS = (
    "monster_uuid",
    "monsterUuid",
    "enemy_uuid",
    "enemyUuid",
    "target_uuid",
    "targetUuid",
)

MONSTER_NAME_KEYS = (
    "monster_name",
    "monsterName",
    "enemy_name",
    "enemyName",
    "target_name",
    "targetName",
    "monster_id",
    "monsterId",
    "enemy_id",
    "enemyId",
    "target_id",
    "targetId",
)

MONSTER_DESCRIPTOR_UUID_KEYS = (
    "uuid",
    "monster_uuid",
    "monsterUuid",
    "enemy_uuid",
    "enemyUuid",
    "target_uuid",
    "targetUuid",
)

MONSTER_DESCRIPTOR_NAME_KEYS = (
    "name",
    "monster_name",
    "monsterName",
    "enemy_name",
    "enemyName",
    "target_name",
    "targetName",
    "monster_id",
    "monsterId",
    "enemy_id",
    "enemyId",
    "target_id",
    "targetId",
    "id",
    "label",
    "display",
    "display_name",
    "displayName",
)

MONSTER_LIST_KEYS = (
    "monsters",
    "monster_list",
    "enemy_list",
    "enemies",
    "current_monsters",
    "active_monsters",
    "living_monsters",
)


def normalize_key_name(value: Any) -> Optional[str]:
    if value is None:
        return None
    key = str(value).strip()
    if not key:
        return None
    upper = key.upper()
    if upper in CARD_KEY_ALIASES:
        return CARD_KEY_ALIASES[upper]
    if upper in SPECIAL_KEY_ALIASES:
        return SPECIAL_KEY_ALIASES[upper]
    # Allow direct CARD_* names and other supported identifiers.
    return upper


def normalize_click_button(value: Any) -> str:
    if value is None:
        return "LEFT"
    name = str(value).strip().upper()
    if name in {"LEFT", "RIGHT"}:
        return name
    if name in {"PRIMARY", "L", "MOUSE1"}:
        return "LEFT"
    if name in {"SECONDARY", "R", "MOUSE2"}:
        return "RIGHT"
    return "LEFT"


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


def extract_hand_cards(state: Any, visited: Optional[Set[int]] = None) -> List[Dict[str, Any]]:
    if state is None:
        return []
    if visited is None:
        visited = set()
    obj_id = id(state)
    if obj_id in visited:
        return []
    visited.add(obj_id)

    if isinstance(state, list):
        if not state:
            return []
        if all(isinstance(item, dict) for item in state):
            if any(
                isinstance(card, dict)
                and any(key in card for key in ("uuid", "card_uuid", "card_id", "cardId", "id", "name", "card_name"))
                for card in state
            ):
                return state  # type: ignore[return-value]
        for item in state:
            if isinstance(item, (dict, list)):
                hand = extract_hand_cards(item, visited)
                if hand:
                    return hand
        return []

    if not isinstance(state, dict):
        return []

    for key in HAND_LIST_KEYS:
        value = state.get(key)
        if isinstance(value, list):
            if not value:
                return value  # empty hand still useful
            if all(isinstance(item, dict) for item in value):
                if any(
                    isinstance(card, dict)
                    and any(key in card for key in ("uuid", "card_uuid", "card_id", "cardId", "id", "name", "card_name"))
                    for card in value
                ):
                    return value  # type: ignore[return-value]

    for child in state.values():
        if isinstance(child, (dict, list)):
            hand = extract_hand_cards(child, visited)
            if hand:
                return hand
    return []


def hand_index_for_uuid(gs: Dict[str, Any], uuid: str) -> Optional[int]:
    if not uuid:
        return None
    hand = extract_hand_cards(gs)
    if not hand:
        return None
    target = str(uuid).strip().lower()
    if not target:
        return None
    for idx, card in enumerate(hand):
        candidate = card.get("uuid") or card.get("card_uuid")
        if candidate and str(candidate).strip().lower() == target:
            return idx
    return None


def extract_monsters(state: Any, visited: Optional[Set[int]] = None) -> List[Dict[str, Any]]:
    if state is None:
        return []
    if visited is None:
        visited = set()
    obj_id = id(state)
    if obj_id in visited:
        return []
    visited.add(obj_id)

    if isinstance(state, list):
        if not state:
            return []
        if all(isinstance(item, dict) for item in state):
            if any(
                isinstance(monster, dict)
                and any(
                    key in monster
                    for key in (
                        *MONSTER_DESCRIPTOR_UUID_KEYS,
                        *MONSTER_DESCRIPTOR_NAME_KEYS,
                        "current_hp",
                        "currentHp",
                        "max_hp",
                        "maxHp",
                        "intent",
                        "is_dead",
                        "isDead",
                    )
                )
                for monster in state
            ):
                return state  # type: ignore[return-value]
        for item in state:
            if isinstance(item, (dict, list)):
                monsters = extract_monsters(item, visited)
                if monsters:
                    return monsters
        return []

    if not isinstance(state, dict):
        return []

    for key in MONSTER_LIST_KEYS:
        value = state.get(key)
        if isinstance(value, list):
            if not value:
                return value
            if all(isinstance(item, dict) for item in value):
                if any(
                    isinstance(monster, dict)
                    and any(
                        key in monster
                        for key in (
                            *MONSTER_DESCRIPTOR_UUID_KEYS,
                            *MONSTER_DESCRIPTOR_NAME_KEYS,
                            "current_hp",
                            "currentHp",
                            "max_hp",
                            "maxHp",
                            "intent",
                            "is_dead",
                            "isDead",
                        )
                    )
                    for monster in value
                ):
                    return value  # type: ignore[return-value]
        elif isinstance(value, dict):
            inner = value.get("monsters")
            if isinstance(inner, list):
                if not inner:
                    return inner
                if all(isinstance(item, dict) for item in inner):
                    return inner  # type: ignore[return-value]

    for child in state.values():
        if isinstance(child, (dict, list)):
            monsters = extract_monsters(child, visited)
            if monsters:
                return monsters
    return []


def parse_int(value: Any) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        try:
            return int(value)
        except (TypeError, ValueError):
            return None
    text = str(value).strip()
    if not text:
        return None
    try:
        return int(float(text))
    except (TypeError, ValueError):
        return None


def parse_card_index(value: Any) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        idx = int(value)
    else:
        text = str(value).strip().upper()
        if not text:
            return None
        if text.startswith("CARD_"):
            text = text[5:]
        try:
            idx = int(float(text))
        except (TypeError, ValueError):
            return None
    if idx == 0:
        idx = 10
    if idx < 1 or idx > 10:
        return None
    return idx


def resolve_card_index(args: Dict[str, Any]) -> int:
    uuid: Optional[str] = None
    card_name: Optional[str] = None
    card_id: Optional[str] = None

    def normalize_text(value: Any) -> Optional[str]:
        if value is None:
            return None
        text = str(value).strip()
        return text if text else None

    def resolve_numeric(value: Any, *, zero_based: bool = False) -> Optional[int]:
        if zero_based:
            raw = parse_int(value)
            if raw is None:
                return None
            idx = raw + 1
        else:
            idx = parse_card_index(value)
        if idx is None:
            return None
        if 1 <= idx <= 10:
            return idx
        return None

    for key in CARD_INDEX_KEYS:
        if key not in args:
            continue
        value = args.get(key)
        if isinstance(value, dict):
            continue
        normalized = key.lower()
        idx = resolve_numeric(value, zero_based=normalized in ZERO_BASED_CARD_KEYS)
        if idx is not None:
            return idx
        if key.lower() == "card" and card_name is None:
            card_name = normalize_text(value)

    card_spec = args.get("card")
    if isinstance(card_spec, dict):
        for key in CARD_INDEX_KEYS:
            if key not in card_spec:
                continue
            value = card_spec.get(key)
            if isinstance(value, dict):
                continue
            normalized = key.lower()
            idx = resolve_numeric(value, zero_based=normalized in ZERO_BASED_CARD_KEYS)
            if idx is not None:
                return idx
        for key in CARD_UUID_KEYS:
            if uuid is None and key in card_spec:
                uuid = normalize_text(card_spec.get(key))
        for key in CARD_ID_KEYS:
            if card_id is None and key in card_spec:
                card_id = normalize_text(card_spec.get(key))
        for key in CARD_NAME_KEYS:
            if card_name is None and key in card_spec:
                card_name = normalize_text(card_spec.get(key))
    elif card_spec is not None and card_name is None:
        card_name = normalize_text(card_spec)

    for key in CARD_UUID_KEYS:
        if uuid is None and key in args:
            uuid = normalize_text(args.get(key))
    for key in CARD_ID_KEYS:
        if card_id is None and key in args:
            card_id = normalize_text(args.get(key))
    for key in CARD_NAME_KEYS:
        if card_name is None and key in args:
            card_name = normalize_text(args.get(key))

    state = controller.get_state(full=True, refresh=False)
    if state is None:
        state = controller.get_state(full=True, refresh=True)
    game_state = (state or {}).get("game_state") if isinstance(state, dict) else None
    if not isinstance(game_state, dict):
        game_state = state if isinstance(state, dict) else {}
    hand = extract_hand_cards(game_state)

    def matches_card_text(candidate: Any, target: str) -> bool:
        if candidate is None:
            return False
        cand = str(candidate).strip().lower()
        targ = target.strip().lower()
        if not cand or not targ:
            return False
        if cand == targ:
            return True
        cand_comp = cand.replace("_", "").replace(" ", "")
        targ_comp = targ.replace("_", "").replace(" ", "")
        if cand_comp == targ_comp:
            return True
        if cand.startswith(targ) or targ.startswith(cand):
            return True
        if cand_comp.startswith(targ_comp) or targ_comp.startswith(cand_comp):
            return True
        return False

    if hand:
        if uuid:
            target_uuid = uuid.strip().lower()
            for idx, card in enumerate(hand):
                card_uuid = None
                for key in CARD_UUID_KEYS:
                    if key in card and card[key]:
                        card_uuid = str(card[key]).strip().lower()
                        break
                if card_uuid and card_uuid == target_uuid:
                    return idx + 1
        if card_id:
            for idx, card in enumerate(hand):
                for key in CARD_ID_KEYS:
                    if key in card and matches_card_text(card[key], card_id):
                        return idx + 1
        if card_name:
            for idx, card in enumerate(hand):
                for key in (*CARD_NAME_KEYS, *CARD_ID_KEYS):
                    if key in card and matches_card_text(card[key], card_name):
                        return idx + 1

    raise ValueError(f"Card index could not be resolved from args: {args}")


def resolve_monster_index(args: Dict[str, Any]) -> Optional[int]:
    uuid: Optional[str] = None
    monster_name: Optional[str] = None

    def normalize_text(value: Any) -> Optional[str]:
        if value is None:
            return None
        text = str(value).strip()
        return text if text else None

    def is_click_spec(value: Any) -> bool:
        return isinstance(value, dict) and {"x", "y"}.issubset(value.keys())

    def resolve_numeric(value: Any, *, zero_based: bool = False) -> Optional[int]:
        idx = parse_int(value)
        if idx is None:
            return None
        if zero_based:
            idx += 1
        if idx < 1:
            return None
        return idx

    def ingest_descriptor(spec: Dict[str, Any]) -> Optional[int]:
        nonlocal uuid, monster_name
        if not isinstance(spec, dict) or is_click_spec(spec):
            return None
        for key in (*MONSTER_INDEX_KEYS, *MONSTER_DIRECT_KEYS, "index"):
            if key not in spec:
                continue
            value = spec.get(key)
            if is_click_spec(value):
                continue
            idx = resolve_numeric(value, zero_based=str(key).lower() in ZERO_BASED_MONSTER_KEYS)
            if idx is not None:
                return idx
            text = normalize_text(value)
            if text and monster_name is None:
                monster_name = text
        for key in MONSTER_DESCRIPTOR_UUID_KEYS:
            if key in spec and uuid is None:
                text = normalize_text(spec.get(key))
                if text:
                    uuid = text
        for key in MONSTER_DESCRIPTOR_NAME_KEYS:
            if key in spec and monster_name is None:
                text = normalize_text(spec.get(key))
                if text:
                    monster_name = text
        return None

    for key in MONSTER_INDEX_KEYS:
        if key not in args:
            continue
        value = args.get(key)
        if isinstance(value, dict):
            idx = ingest_descriptor(value)
            if idx is not None:
                return idx
            continue
        idx = resolve_numeric(value, zero_based=key.lower() in ZERO_BASED_MONSTER_KEYS)
        if idx is not None:
            return idx
        text = normalize_text(value)
        if text and monster_name is None:
            monster_name = text

    for key in MONSTER_DIRECT_KEYS:
        if key not in args:
            continue
        value = args.get(key)
        if isinstance(value, dict):
            idx = ingest_descriptor(value)
            if idx is not None:
                return idx
            continue
        if is_click_spec(value):
            continue
        idx = resolve_numeric(value, zero_based=key.lower() in ZERO_BASED_MONSTER_KEYS)
        if idx is not None:
            return idx
        text = normalize_text(value)
        if text and monster_name is None:
            monster_name = text

    for key in MONSTER_UUID_KEYS:
        if key in args and uuid is None:
            text = normalize_text(args.get(key))
            if text:
                uuid = text

    for key in MONSTER_NAME_KEYS:
        if key in args and monster_name is None:
            text = normalize_text(args.get(key))
            if text:
                monster_name = text

    if uuid is None and monster_name is None:
        return None

    state = controller.get_state(full=True, refresh=False)
    if state is None:
        state = controller.get_state(full=True, refresh=True)
    game_state = (state or {}).get("game_state") if isinstance(state, dict) else None
    if not isinstance(game_state, dict):
        game_state = state if isinstance(state, dict) else {}
    monsters = extract_monsters(game_state)

    if not monsters:
        raise ValueError(f"Monster index could not be resolved from args: {args}")

    def matches_text(candidate: Any, target: str) -> bool:
        if candidate is None:
            return False
        cand = str(candidate).strip().lower()
        targ = target.strip().lower()
        if not cand or not targ:
            return False
        if cand == targ:
            return True
        cand_comp = cand.replace("_", "").replace(" ", "")
        targ_comp = targ.replace("_", "").replace(" ", "")
        if cand_comp == targ_comp:
            return True
        if cand.startswith(targ) or targ.startswith(cand):
            return True
        if cand_comp.startswith(targ_comp) or targ_comp.startswith(cand_comp):
            return True
        return False

    def iter_monster_values(monster: Dict[str, Any], keys: Tuple[str, ...]) -> List[Any]:
        values: List[Any] = []
        stack: List[Any] = [monster]
        visited: Set[int] = set()
        while stack:
            item = stack.pop()
            item_id = id(item)
            if item_id in visited:
                continue
            visited.add(item_id)
            if isinstance(item, dict):
                for key in keys:
                    if key in item and item[key] not in (None, ""):
                        values.append(item[key])
                for child in item.values():
                    if isinstance(child, (dict, list)):
                        stack.append(child)
            elif isinstance(item, list):
                for child in item:
                    if isinstance(child, (dict, list)):
                        stack.append(child)
        return values

    if uuid:
        target_uuid = uuid.strip().lower()
        for idx, monster in enumerate(monsters):
            for candidate in iter_monster_values(monster, MONSTER_DESCRIPTOR_UUID_KEYS):
                if candidate is None:
                    continue
                cand = str(candidate).strip().lower()
                if cand and cand == target_uuid:
                    return idx + 1

    if monster_name:
        for idx, monster in enumerate(monsters):
            for candidate in iter_monster_values(monster, MONSTER_DESCRIPTOR_NAME_KEYS):
                if matches_text(candidate, monster_name):
                    return idx + 1

    raise ValueError(f"Monster index could not be resolved from args: {args}")


def parse_click_args(value: Any) -> Tuple[float, float, str]:
    if not isinstance(value, dict):
        raise ValueError("Click args must be an object with x/y")
    if "x" not in value or "y" not in value:
        raise ValueError("Click args missing x/y coordinates")
    try:
        fx = float(value.get("x"))
        fy = float(value.get("y"))
    except (TypeError, ValueError):
        raise ValueError("Click coordinates must be numbers")
    button = normalize_click_button(value.get("button"))
    return fx, fy, button


def execute_step(step: Dict[str, Any]) -> None:
    cmd = (step.get("command") or "").lower()
    args = step.get("args") or {}

    log(f"Executing step: command={cmd}, args={args}")

    if cmd == "wait":
        ms_value = args.get("ms", 100)
        try:
            ms = int(ms_value)
        except (TypeError, ValueError):
            raise ValueError("wait command requires numeric 'ms'")
        send(f"wait {ms}")
        wait_ms(ms)
        return
    if cmd == "state":
        send("state")
        _ = read_line()
        return
    if cmd == "key":
        raw_key = args.get("key") or args.get("value")
        key = normalize_key_name(raw_key)
        if not key:
            raise ValueError("key command missing key/value")
        send(f"key {key}")
        wait_ms(args.get("pause_ms", PAUSE_MS_AFTER_KEY))
        return
    if cmd == "click":
        x = args.get("x")
        y = args.get("y")
        if x is None or y is None:
            raise ValueError("click command missing x/y coordinates")
        button = normalize_click_button(args.get("button") or args.get("value"))
        try:
            fx = float(x)
            fy = float(y)
        except (TypeError, ValueError):
            raise ValueError("click coordinates must be numbers")
        send(f"click {button} {fx} {fy}")
        wait_ms(args.get("pause_ms", PAUSE_MS_AFTER_CLICK))
        return
    if cmd == "card":
        idx = resolve_card_index(args)
        key_name = normalize_key_name(str(idx))
        if not key_name:
            raise ValueError(f"unable to map card index {idx} to key")
        send(f"key {key_name}")
        wait_ms(args.get("pause_ms", PAUSE_MS_AFTER_KEY))
        return

    if cmd == "choose":
        index = args.get("index")
        if index is None:
            index = args.get("value")
        if index is None:
            raise ValueError("choose command missing index/value")
        try:
            choice = int(index)
        except (TypeError, ValueError):
            choice = index
        send(f"choose {choice}")
        wait_ms(args.get("pause_ms", PAUSE_MS_AFTER_KEY))
        return

    if cmd == "end":
        raw_key = args.get("key") or args.get("value") or "END_TURN"
        key = normalize_key_name(raw_key)
        if not key:
            raise ValueError("end command missing key mapping")
        send(f"key {key}")
        wait_ms(args.get("pause_ms", PAUSE_MS_AFTER_KEY))
        return

    if cmd == "play":
        idx = resolve_card_index(args)
        monster_idx = resolve_monster_index(args)
        if monster_idx is not None:
            send(f"play {idx} {monster_idx}")
        else:
            send(f"play {idx}")
        wait_ms(args.get("pause_ms", PAUSE_MS_AFTER_KEY))
        target = args.get("click")
        if isinstance(target, dict) and monster_idx is None:
            fx, fy, button = parse_click_args(target)
            send(f"click {button} {fx} {fy}")
            wait_ms(args.get("target_pause_ms", PAUSE_MS_AFTER_CLICK))
        elif target is not None and monster_idx is None:
            raise ValueError("play click target must be an object with x/y")
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
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self._set_headers()
            self.wfile.write(b"{\"status\": \"ok\"}")
            return
        if parsed.path == "/state":
            params = parse_qs(parsed.query)
            full = False
            refresh = True
            if "full" in params:
                full = any(value.lower() in ("1", "true", "yes") for value in params.get("full", []))
            if "refresh" in params:
                refresh = not any(value.lower() in ("0", "false", "no") for value in params.get("refresh", []))
            state = controller.get_state(full=full, refresh=refresh)
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
