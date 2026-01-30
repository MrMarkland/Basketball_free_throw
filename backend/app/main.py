import json, uuid
from fastapi import FastAPI, WebSocket, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware

from .drive import get_or_create_folder, upload_json, upload_file
from .session import start_session, get_session, new_attempt, resolve_attempt

app = FastAPI(title="Free Throw – Google Drive Storage")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

ROOT_ID = None

@app.on_event("startup")
def init():
    global ROOT_ID
    ROOT_ID = get_or_create_folder("FreeThrowData")

@app.post("/session/start")
def session_start(session_id: str = Form(...)):
    start_session(session_id)
    sid = get_or_create_folder(session_id, ROOT_ID)
    upload_json("session.json", get_session(session_id), sid)
    return {"ok": True}

@app.websocket("/ws/telemetry")
async def telemetry(ws: WebSocket):
    await ws.accept()

    while True:
        data = json.loads(await ws.receive_text())
        session_id = data["session_id"]
        typ = data["type"]

        sess = get_session(session_id)
        session_folder = get_or_create_folder(session_id, ROOT_ID)

        if typ == "attempt":
            attempt_id = uuid.uuid4().hex
            new_attempt(session_id, attempt_id, data["team"], data["player_id"])

            a_folder = get_or_create_folder("attempts", session_folder)
            af = get_or_create_folder(attempt_id, a_folder)

            upload_json("metadata.json", sess["attempts"][attempt_id], af)
            await ws.send_json({"attempt_id": attempt_id})

        elif typ == "pose":
            sess["attempts"][data["attempt_id"]]["pose"].append(data["pose"])

        elif typ in ("made", "miss"):
            resolve_attempt(session_id, data["attempt_id"], typ)
            upload_json("scoreboard.json", sess["scoreboard"], session_folder)
