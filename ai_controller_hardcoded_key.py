# ai_combo_controller_gui.py
# A GUI helper for CommunicationMod:
#  - Buttons to Snapshot / Plan / Plan+Execute
#  - Uses GPT-5 structured output to get an action sequence
#  - Sends real commands to the mod via STDOUT
#
# In CommunicationMod config.properties:
#   command=python -u C:/Path/ai_combo_controller_gui.py
#
# Requires: pip install openai>=1.0.0

import sys, os, json, time, threading
from typing import Any, Dict, List, Optional

# ====== YOUR SETTINGS ======
OPENAI_API_KEY = "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"   # <--- put your key here
OPENAI_MODEL   = "gpt-5"
SEND_TRIMMED_TO_GPT = True         # send lean snapshot to GPT
PAUSE_MS_AFTER_KEY   = 150
PAUSE_MS_AFTER_CLICK = 120
# ===========================

# --- OpenAI client ---
try:
    from openai import OpenAI
except Exception:
    sys.stderr.write("Missing OpenAI SDK. Install: pip install openai\n")
    sys.stderr.flush()
    raise

client = OpenAI(api_key=OPENAI_API_KEY)

# --- GUI (tkinter) ---
import tkinter as tk
from tkinter import messagebox

def log(msg: str):
    sys.stderr.write(msg + "\n"); sys.stderr.flush()
    try:
        text_log.configure(state="normal")
        text_log.insert("end", msg + "\n")
        text_log.see("end")
        text_log.configure(state="disabled")
    except Exception:
        pass

# --- Mod I/O: STDOUT = commands, STDIN = JSON state ---
def send(cmd: str) -> None:
    log(f"[send] -> {cmd}")
    sys.stdout.write(cmd + "\n")
    sys.stdout.flush()

def read_line() -> Optional[str]:
    # Read one JSON line from CommunicationMod
    for line in sys.stdin:
        line = line.rstrip("\r\n")
        if line:
            return line
    return None

def wait_ms(ms: int) -> None:
    time.sleep(ms/1000.0)

def get_state() -> Dict[str, Any]:
    log("Requesting game state from CommunicationMod...")
    send("state")
    raw = read_line()
    if not raw:
        log("[state] No response received.")
        return {}
    try:
        data = json.loads(raw)
        log("[state] JSON parsed successfully.")
        return data
    except Exception as exc:
        log(f"[state] Failed to parse JSON: {exc}")
        return {}

# --- Snapshot trimming (combat = full minus map; else screen-relevant) ---
def prune_empty(x):
    if isinstance(x, dict):
        y = {k: prune_empty(v) for k,v in x.items()}
        return {k:v for k,v in y.items() if v not in (None, {}, [], "")}
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

def relic_names(relics):
    out=[]
    for r in (relics or []):
        name = r.get("name", r.get("id"))
        if name and name != "Potion Slot":
            out.append(name)
    return out

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
    return prune_empty(view)

def in_combat_like(gs: Dict[str, Any]) -> bool:
    st = (gs.get("screen_type") or "").upper()
    if st == "COMBAT": return True
    rp = (gs.get("room_phase") or "").upper()
    if rp == "COMBAT": return True
    ap = (gs.get("action_phase") or "").upper()
    if ap and ap not in ("WAITING_ON_USER","",None): return True
    return False

def make_trimmed_snapshot(envelope: Dict[str, Any]) -> Dict[str, Any]:
    gs = envelope.get("game_state", {}) or {}
    st = gs.get("screen_type")
    if in_combat_like(gs):
        full = dict(gs); full.pop("map", None)
        return {
            "ready_for_command": envelope.get("ready_for_command"),
            "in_game": envelope.get("in_game"),
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
            "potions": [p.get("name") for p in (gs.get("potions") or []) if p.get("name")!="Potion Slot"],
        }
        view = filter_noncombat_view(st, gs)
        return {
            "ready_for_command": envelope.get("ready_for_command"),
            "in_game": envelope.get("in_game"),
            "screen_type": st,
            "header": prune_empty(header),
            "view": view,
        }

def copy_to_clipboard(s: str):
    try:
        root.clipboard_clear()
        root.clipboard_append(s)
        root.update()  # keep it available after window loses focus
        return True
    except Exception:
        return False

# --- Execution helpers ---
def hand_index_for_uuid(gs: Dict[str, Any], uuid: str) -> Optional[int]:
    hand = gs.get("hand")
    if hand is None:
        hand = gs.get("game_state", {}).get("hand")
    if not hand:
        return None
    for i, card in enumerate(hand):
        if card.get("uuid") == uuid:
            return i
    return None

def execute_step(step: Dict[str, Any]) -> None:
    cmd = (step.get("command") or "").lower()
    args = step.get("args") or {}

    log(f"Executing step: command={cmd}, args={args}")

    if cmd == "wait":
        wait_ms(int(args.get("ms", 100))); return
    if cmd == "state":
        send("state"); _ = read_line(); return
    if cmd == "key":
        send(f'key {args.get("value")}'); wait_ms(PAUSE_MS_AFTER_KEY); return
    if cmd == "click":
        x, y = args.get("x"), args.get("y")
        if x is not None and y is not None:
            send(f"click {int(x)} {int(y)}"); wait_ms(PAUSE_MS_AFTER_CLICK)
        return
    if cmd == "choose":
        send(f'choose {int(args.get("index",0))}'); return

    if cmd == "end":
        send("key e"); wait_ms(PAUSE_MS_AFTER_KEY); return

    if cmd == "play":
        uuid = args.get("uuid")
        if not uuid: return
        s = get_state()
        gs = s.get("game_state", s)
        idx = hand_index_for_uuid(gs, uuid)
        if idx is None:
            log(f"[play] Card with UUID {uuid} not found in hand.")
            return
        send(f"key {idx+1}")
        wait_ms(PAUSE_MS_AFTER_KEY)
        targ = args.get("click")
        if isinstance(targ, dict) and "x" in targ and "y" in targ:
            send(f'click {int(targ["x"])} {int(targ["y"])}')
            wait_ms(PAUSE_MS_AFTER_CLICK)
        return

# --- GPT: structured output schema ---
SYSTEM_INSTRUCTIONS = """You are an expert Slay the Spire planner that outputs an action SEQUENCE.
Rules:
- Return ONLY JSON that matches the provided schema.
- Prefer native commands: key, click, choose, wait, state.
- You MAY use convenience commands 'play' with {"uuid":"..."} and 'end' with {}.
- If a card needs a target, include args.click {x,y} or skip the play.
- Keep sequences short (<=5 steps). No prose, no extra fields."""

ACTION_SCHEMA: Dict[str, Any] = {
    "name": "ActionSequence",
    "schema": {
        "type": "object",
        "properties": {
            "sequence": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "command": {"type":"string","enum":["key","click","choose","wait","state","play","end"]},
                        "args": {
                            "type":"object",
                            "properties": {
                                "value":{"type":"string"},
                                "index":{"type":"integer"},
                                "ms":{"type":"integer","minimum":0},
                                "x":{"type":"integer"},
                                "y":{"type":"integer"},
                                "uuid":{"type":"string"},
                                "click":{
                                    "type":"object",
                                    "properties":{"x":{"type":"integer"},"y":{"type":"integer"}},
                                    "required":["x","y"],
                                    "additionalProperties": False
                                }
                            },
                            "additionalProperties": True
                        }
                    },
                    "required": ["command","args"],
                    "additionalProperties": False
                }
            }
        },
        "required": ["sequence"],
        "additionalProperties": False
    },
    "strict": True
}

def plan_with_gpt(state_envelope: dict) -> list[dict]:
    # send trimmed payload if you set that flag elsewhere in your script
    payload = make_trimmed_snapshot(state_envelope) if SEND_TRIMMED_TO_GPT else state_envelope
    state_str = json.dumps(payload, separators=(",", ":"))

    log(f"Planning with GPT. Trimmed={SEND_TRIMMED_TO_GPT}, payload_bytes={len(state_str)}")

    # Messages used by both APIs
    system_msg = SYSTEM_INSTRUCTIONS
    user_msg = (
        "Current run state JSON:\n"
        f"{state_str}\n"
        "Return only the sequence object that matches the schema."
    )

    # 1) Try Responses API with JSON Schema (new SDKs)
    try:
        log("Calling OpenAI Responses API with JSON schema.")
        resp = client.responses.create(
            model=OPENAI_MODEL,
            response_format={"type": "json_schema", "json_schema": ACTION_SCHEMA},
            input=[
                {"role": "system", "content": system_msg},
                {"role": "user", "content": user_msg},
            ],
            max_output_tokens=800,
        )
        # Prefer parsed structured output if present
        try:
            parsed = resp.output[0].content[0].parsed  # new SDK field
            log("Received parsed response from Responses API.")
            return parsed.get("sequence", [])
        except Exception:
            pass
        # Fallback: plain text content
        try:
            text = resp.output_text
        except Exception:
            text = resp.output[0].content[0].text
        log("Responses API returned text; attempting to parse JSON.")
        data = json.loads(text)
        return data.get("sequence", [])
    except TypeError:
        # Your SDK likely doesn't support response_format on Responses API
        log("Responses API TypeError: response_format unsupported, falling back to Chat Completions.")
        pass
    except Exception as e:
        log(f"OpenAI (responses) error: {e}")

    # 2) Fallback: Chat Completions JSON mode (works on older SDKs)
    try:
        log("Calling OpenAI Chat Completions API in JSON mode.")
        chat = client.chat.completions.create(
            model=OPENAI_MODEL,  # if this model isn't available for chat, try "gpt-4o-mini"
            response_format={"type": "json_object"},
            temperature=0,
            messages=[
                {"role": "system", "content": system_msg + "\nReturn ONLY a JSON object of the form {\"sequence\": [...]}."},
                {"role": "user", "content": user_msg},
            ],
            max_tokens=800,
        )
        content = chat.choices[0].message.content
        log("Chat Completions returned content; parsing JSON.")
        data = json.loads(content)
        seq = data.get("sequence", [])
        if not isinstance(seq, list):
            log("Chat response did not contain a list sequence.")
            return []
        # Optional: minimal schema check
        good = []
        for step in seq:
            if isinstance(step, dict) and "command" in step and "args" in step:
                good.append(step)
            else:
                log(f"Dropping invalid step from chat response: {step}")
        return good
    except Exception as e:
        log(f"OpenAI (chat) error: {e}")
        return []

# --- Button actions (run in worker threads so the UI doesn't freeze) ---
def do_snapshot():
    def work():
        state = get_state()
        if not state:
            log("No state received during snapshot request."); return
        trimmed = make_trimmed_snapshot(state)
        out = json.dumps(trimmed, ensure_ascii=False, separators=(",", ":"))
        try:
            with open("run_snapshot.json","w",encoding="utf-8") as f:
                f.write(out+"\n")
        except Exception as e:
            log(f"Write error: {e}")
        if copy_to_clipboard(out):
            log("Snapshot saved & copied to clipboard.")
        else:
            log("Snapshot saved locally; clipboard unavailable.")
    threading.Thread(target=work, daemon=True).start()

def do_plan_only():
    def work():
        state = get_state()
        if not state:
            log("No state received for planning."); return
        seq = plan_with_gpt(state)
        try:
            txt = json.dumps({"sequence":seq}, ensure_ascii=False, separators=(",", ":"))
        except Exception:
            txt = str(seq)
        log("Planned (no execute):")
        log(txt)
    threading.Thread(target=work, daemon=True).start()

def do_plan_and_execute():
    def work():
        state = get_state()
        if not state:
            log("No state received before plan+execute."); return
        seq = plan_with_gpt(state)
        if not isinstance(seq, list) or not seq:
            log("Model returned no sequence."); return
        for step in seq:
            try:
                execute_step(step)
            except Exception as ex:
                log(f"Step error {step}: {ex}")
        log("Finished executing planned sequence.")
        log("Sequence executed.")
    threading.Thread(target=work, daemon=True).start()

def on_close():
    root.destroy()

# ---- Handshake so CommunicationMod starts ----
sys.stdout.write("ready\n"); sys.stdout.flush()

# ---- Build GUI ----
root = tk.Tk()
root.title("StS AI Helper")

frm = tk.Frame(root, padx=8, pady=8)
frm.pack(fill="both", expand=True)

btn1 = tk.Button(frm, text="Plan + Execute", width=20, command=do_plan_and_execute)
btn2 = tk.Button(frm, text="Snapshot",       width=20, command=do_snapshot)
btn3 = tk.Button(frm, text="Plan only",      width=20, command=do_plan_only)
btn4 = tk.Button(frm, text="Quit",           width=20, command=on_close)

btn1.grid(row=0, column=0, padx=4, pady=4, sticky="ew")
btn2.grid(row=0, column=1, padx=4, pady=4, sticky="ew")
btn3.grid(row=1, column=0, padx=4, pady=4, sticky="ew")
btn4.grid(row=1, column=1, padx=4, pady=4, sticky="ew")

text_log = tk.Text(frm, height=12, width=64, state="disabled")
text_log.grid(row=2, column=0, columnspan=2, padx=4, pady=6, sticky="nsew")

frm.grid_rowconfigure(2, weight=1)
frm.grid_columnconfigure(0, weight=1)
frm.grid_columnconfigure(1, weight=1)

root.protocol("WM_DELETE_WINDOW", on_close)
log("Ready. Use the buttons above.")

root.mainloop()
