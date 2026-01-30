from datetime import datetime

_sessions = {}

def now():
    return datetime.utcnow().isoformat() + "Z"

def start_session(session_id):
    _sessions[session_id] = {
        "created_at": now(),
        "scoreboard": {"A": 0, "B": 0},
        "attempts": {}
    }

def get_session(session_id):
    return _sessions.get(session_id)

def new_attempt(session_id, attempt_id, team, player):
    s = _sessions[session_id]
    s["attempts"][attempt_id] = {
        "team": team,
        "player_id": player,
        "made": "unknown",
        "created_at": now(),
        "pose": []
    }

def resolve_attempt(session_id, attempt_id, made):
    s = _sessions[session_id]
    a = s["attempts"][attempt_id]
    a["made"] = made
    if made == "made":
        s["scoreboard"][a["team"]] += 1
