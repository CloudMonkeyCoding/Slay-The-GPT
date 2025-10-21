# dump_state_relevant_or_full2.py
import sys, json, subprocess

def send(cmd: str):
    sys.stderr.write(f"[send] -> {cmd}\n"); sys.stderr.flush()
    sys.stdout.write(cmd + "\n")
    sys.stdout.flush()

def read_one_line():
    for line in sys.stdin:
        line = line.rstrip("\r\n")
        if line:
            return line
    return None

def prune_empty(x):
    if isinstance(x, dict):
        y = {k: prune_empty(v) for k, v in x.items()}
        return {k: v for k, v in y.items() if v not in (None, {}, [], "")}
    if isinstance(x, list):
        y = [prune_empty(v) for v in x]
        return [v for v in y if v not in (None, {}, [], "")]
    return x

REWARD_KEYS = {"rewards","cards","relic","gold_gain","choice_list","screen_state","room_type"}
SHOP_KEYS   = {"shop","removals_left","prices","choice_list","screen_state","room_type"}
CHEST_KEYS  = {"chest_type","relics","can_open","choice_list","screen_state","room_type"}
CAMPFIRE_KEYS = {"options","choice_list","screen_state","room_type"}
EVENT_KEYS  = {"screen_state","choice_list","room_type"}
MAP_KEYS    = {"map","path","choice_list","screen_state","room_type"}
GAMEOVER_KEYS = {"score","killed_by","floor_reached","choice_list","screen_state","room_type"}
COMMON_KEEP = {"choice_list","screen_state","room_type"}

def filter_noncombat_view(st, gs):
    st = (st or "").upper()
    if st in ("CARD_REWARD","BOSS_REWARD","CHEST_REWARD","REWARD"):
        keep = REWARD_KEYS
    elif st == "SHOP":
        keep = SHOP_KEYS
    elif st in ("CHEST","TREASURE"):
        keep = CHEST_KEYS
    elif st in ("REST","CAMPFIRE"):
        keep = CAMPFIRE_KEYS
    elif st == "EVENT":
        keep = EVENT_KEYS
    elif st == "MAP":
        keep = MAP_KEYS
    elif st in ("GAME_OVER","DEATH"):
        keep = GAMEOVER_KEYS
    else:
        keep = COMMON_KEEP
    view = {k: gs[k] for k in keep if k in gs}
    if st != "MAP":
        view.pop("map", None)
    # drop empty screen_state/choice_list/etc.
    return prune_empty(view)

def in_combat_like(gs):
    st = (gs.get("screen_type") or "").upper()
    if st == "COMBAT":
        return True
    rp = (gs.get("room_phase") or "").upper()
    if rp == "COMBAT":
        return True
    ap = (gs.get("action_phase") or "").upper()
    if ap and ap not in ("WAITING_ON_USER","",None):
        # Heuristic: treat non-empty action_phase as combat-ish
        return True
    return False

def relic_names(relics):
    out = []
    for r in (relics or []):
        name = r.get("name", r.get("id"))
        if name and name != "Potion Slot":
            out.append(name)
    return out

# -------- main --------
send("ready")
sys.stderr.write("Ready. Press Enter for a snapshot (q to quit).\n")
sys.stderr.flush()

while True:
    try:
        user = input()
    except EOFError:
        break
    if user.strip().lower() == "q":
        break

    sys.stderr.write("Requesting state from CommunicationMod...\n"); sys.stderr.flush()
    send("state")
    raw = read_one_line()
    if not raw:
        sys.stderr.write("No data received.\n"); sys.stderr.flush()
        continue

    try:
        obj = json.loads(raw)
        sys.stderr.write("State JSON parsed successfully.\n"); sys.stderr.flush()
        gs = obj.get("game_state", {}) or {}
        st = gs.get("screen_type")

        if in_combat_like(gs):
            # Full state minus map
            full = dict(gs)
            full.pop("map", None)
            trimmed = {
                "ready_for_command": obj.get("ready_for_command"),
                "in_game": obj.get("in_game"),
                "screen_type": st,
                "game_state": prune_empty(full),
            }
        else:
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
            trimmed = {
                "ready_for_command": obj.get("ready_for_command"),
                "in_game": obj.get("in_game"),
                "screen_type": st,
                "header": prune_empty(header),
                "view": view,
            }

        out = json.dumps(trimmed, ensure_ascii=False, separators=(",", ":"))
    except Exception as exc:
        sys.stderr.write(f"Failed to parse JSON: {exc}\n"); sys.stderr.flush()
        out = raw

    # Write + clipboard (Windows)
    try:
        with open("run_snapshot.json", "w", encoding="utf-8") as f:
            f.write(out + "\n")
    except Exception as e:
        sys.stderr.write(f"Write error: {e}\n")
    try:
        subprocess.run(["clip"], input=out, text=True, check=True)
        sys.stderr.write("Snapshot copied.\n")
    except Exception:
        sys.stderr.write("Snapshot saved (clipboard unavailable).\n")
    sys.stderr.flush()
