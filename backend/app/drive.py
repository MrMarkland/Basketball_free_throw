import os
import io
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload
from google.oauth2 import service_account

SCOPES = ["https://www.googleapis.com/auth/drive"]
ROOT_FOLDER_NAME = os.getenv("DRIVE_ROOT", "FreeThrowData")

creds = service_account.Credentials.from_service_account_file(
    os.environ["GOOGLE_APPLICATION_CREDENTIALS"],
    scopes=SCOPES,
)

drive = build("drive", "v3", credentials=creds)

def get_or_create_folder(name, parent=None):
    q = f"name='{name}' and mimeType='application/vnd.google-apps.folder' and trashed=false"
    if parent:
        q += f" and '{parent}' in parents"

    res = drive.files().list(q=q, fields="files(id)").execute()
    if res["files"]:
        return res["files"][0]["id"]

    meta = {
        "name": name,
        "mimeType": "application/vnd.google-apps.folder",
    }
    if parent:
        meta["parents"] = [parent]

    f = drive.files().create(body=meta, fields="id").execute()
    return f["id"]

def upload_json(name, data, parent):
    content = io.BytesIO(bytes(json.dumps(data, indent=2), "utf-8"))
    media = MediaIoBaseUpload(content, mimetype="application/json")
    meta = {"name": name, "parents": [parent]}
    drive.files().create(body=meta, media_body=media).execute()

def upload_file(name, file_bytes, mime, parent):
    media = MediaIoBaseUpload(io.BytesIO(file_bytes), mimetype=mime)
    meta = {"name": name, "parents": [parent]}
    drive.files().create(body=meta, media_body=media).execute()
