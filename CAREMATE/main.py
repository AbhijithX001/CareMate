from fastapi import FastAPI, UploadFile, File, HTTPException, Request, Form
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
import whisper
import sqlite3
import os
import shutil
import subprocess
import base64
from datetime import datetime
from datetime import timedelta
import re
from urllib.parse import quote
from transformers import BartTokenizer, BartForConditionalGeneration
from deepface import DeepFace
from llm import summarize_and_extract, transcribe_audio
from dateutil import parser as dtparser

# Load .env (optional) so you can configure API keys without exporting each run.
try:
    from dotenv import load_dotenv
except Exception:  # pragma: no cover
    load_dotenv = None

if load_dotenv:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    load_dotenv(os.path.join(BASE_DIR, ".env"))

app = FastAPI()

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, replace with specific frontend origin like "http://localhost:5173"
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Lazy model loaders to save RAM and startup time
_whisper_model = None
_tokenizer = None
_summary_model = None

def get_whisper():
    global _whisper_model
    if _whisper_model is None:
        _whisper_model = whisper.load_model("base")
    return _whisper_model

def get_summarizer():
    global _tokenizer, _summary_model
    if _tokenizer is None:
        _tokenizer = BartTokenizer.from_pretrained("facebook/bart-large-cnn")
        _summary_model = BartForConditionalGeneration.from_pretrained("facebook/bart-large-cnn")
    return _tokenizer, _summary_model

# Directories for face matching
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
KNOWN_DIR = os.path.join(BASE_DIR, "known")
TEMP_UPLOAD_DIR = os.path.join(BASE_DIR, "temp_upload")
os.makedirs(KNOWN_DIR, exist_ok=True)
os.makedirs(TEMP_UPLOAD_DIR, exist_ok=True)


# ─── Helpers ────────────────────────────────────────────────────────────────

def convert_to_wav(input_path, output_path):
    command = [
        "ffmpeg", "-y",
        "-i", input_path,
        "-ar", "16000",
        "-ac", "1",
        output_path
    ]
    subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def save_to_db(person_name, transcript, summary):
    conn = sqlite3.connect("caremate.db")
    cursor = conn.cursor()
    cursor.execute(
        "INSERT INTO conversations (person_name, transcript, summary) VALUES (?, ?, ?)",
        (person_name, transcript, summary)
    )
    last_id = cursor.lastrowid
    
    # Fetch the newly created record to return it
    cursor.execute(
        "SELECT id, person_name, transcript, summary, created_at FROM conversations WHERE id = ?", 
        (last_id,)
    )
    row = cursor.fetchone()
    
    conn.commit()
    conn.close()
    
    return {
        "id": row[0],
        "person_name": row[1],
        "transcript": row[2],
        "summary": row[3],
        "created_at": row[4]
    }


def save_reminder(title: str, due_at: str | None, conversation_id: int | None = None):
    conn = sqlite3.connect("caremate.db")
    cursor = conn.cursor()
    cursor.execute(
        "INSERT INTO reminders (title, due_at, status, conversation_id) VALUES (?, ?, 'pending', ?)",
        (title, due_at, conversation_id),
    )
    reminder_id = cursor.lastrowid
    cursor.execute(
        "SELECT id, title, due_at, status, conversation_id, created_at FROM reminders WHERE id = ?",
        (reminder_id,),
    )
    row = cursor.fetchone()
    conn.commit()
    conn.close()
    return {
        "id": row[0],
        "title": row[1],
        "due_at": row[2],
        "status": row[3],
        "conversation_id": row[4],
        "created_at": row[5],
    }


def verify_face(known_image_path: str, current_image_path: str) -> dict:
    """
    Compare a known face image against a current (uploaded) face image.
    Returns the DeepFace verification result dict.
    """
    result = DeepFace.verify(
        img1_path=known_image_path,
        img2_path=current_image_path,
        model_name="ArcFace",
        detector_backend="mtcnn",
        enforce_detection=False
    )
    return result


def list_known_faces() -> list[dict]:
    faces = []
    for filename in os.listdir(KNOWN_DIR):
        path = os.path.join(KNOWN_DIR, filename)
        if not os.path.isfile(path):
            continue
        name, ext = os.path.splitext(filename)
        if ext.lower() not in {".jpg", ".jpeg", ".png"}:
            continue
        faces.append({
            "name": name,
            "filename": filename,
            "image_url": f"/faces/{quote(name)}/image",
        })
    faces.sort(key=lambda item: item["name"].lower())
    return faces


def resolve_known_face_path(person_name: str) -> str | None:
    for ext in (".jpg", ".jpeg", ".png"):
        candidate = os.path.join(KNOWN_DIR, f"{person_name}{ext}")
        if os.path.exists(candidate):
            return candidate
    return None


def delete_existing_face_files(person_name: str):
    for ext in (".jpg", ".jpeg", ".png"):
        path = os.path.join(KNOWN_DIR, f"{person_name}{ext}")
        if os.path.exists(path):
            os.remove(path)


def save_face_image(person_name: str, file: UploadFile) -> str:
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in {".jpg", ".jpeg", ".png"}:
        ext = ".jpg"
    delete_existing_face_files(person_name)
    save_path = os.path.join(KNOWN_DIR, f"{person_name}{ext}")
    with open(save_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
    return save_path


def extract_reminders_fallback(transcript: str) -> list[dict]:
    """
    Best-effort reminder extraction without an LLM.
    Returns [{title: str, due_at: str|None}, ...]
    """
    if not transcript:
        return []

    t = " ".join(transcript.split())
    if not re.search(r"\b(remind|reminder)\b", t, flags=re.IGNORECASE):
        return []

    # Split into sentences-ish chunks.
    parts = re.split(r"(?<=[.!?])\s+", t)
    candidates = [p.strip() for p in parts if re.search(r"\b(remind|reminder)\b", p, flags=re.IGNORECASE)]

    reminders: list[dict] = []
    now = datetime.now()
    for cand in candidates[:5]:
        title = cand
        due_at = None

        # Very small set of patterns to pull out a due time.
        # If parsing fails, we still keep the reminder title.
        try:
            base = now
            if re.search(r"\btomorrow\b", cand, flags=re.IGNORECASE):
                base = now + timedelta(days=1)
                cand_for_parse = re.sub(r"\btomorrow\b", base.strftime("%Y-%m-%d"), cand, flags=re.IGNORECASE)
            else:
                cand_for_parse = cand

            # Handle "at 10 am", "10am", "10 a.m."
            dt = dtparser.parse(cand_for_parse, default=base, fuzzy=True)
            # If the parse returned "now" because nothing date-like was found, don't store it.
            if abs((dt - base).total_seconds()) >= 60:
                due_at = dt.isoformat(timespec="seconds")
        except Exception:
            due_at = None

        # Make title concise: strip common lead-in phrases.
        title = re.sub(r"^\s*remind me\s+(to\s+)?", "", title, flags=re.IGNORECASE)
        title = re.sub(r"^\s*set a reminder\s+(to\s+)?", "", title, flags=re.IGNORECASE)
        title = re.sub(r"^\s*reminder\s*:\s*", "", title, flags=re.IGNORECASE)
        title = title.strip()

        # If still too long, clip to first clause.
        if len(title) > 80:
            title = re.split(r"[,.]", title, maxsplit=1)[0].strip()

        reminders.append({"title": title or cand, "due_at": due_at})

    # De-dup by title
    seen = set()
    out = []
    for r in reminders:
        key = r["title"].lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
    return out


def clean_reminder_title(title: str) -> str:
    t = (title or "").strip()
    t = re.sub(r"^\s*(hi|hello|hey)\b[,:\s-]*", "", t, flags=re.IGNORECASE)
    t = re.sub(r"^\s*(remind me|set a reminder)\b\s*(to)?\s*", "", t, flags=re.IGNORECASE)
    t = re.sub(r"\s+", " ", t).strip(" .,:;-")
    if not t:
        return ""
    if len(t.split()) > 10:
        t = " ".join(t.split()[:10])
    return t


# ─── Routes ─────────────────────────────────────────────────────────────────

@app.post("/process-audio")
async def process_audio(
    file: UploadFile = File(...), 
    person_name: str = Form("Unknown")
):
    try:
        raw_path = f"raw_{file.filename}"
        wav_path = "converted.wav"

        with open(raw_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        convert_to_wav(raw_path, wav_path)

        transcript = None
        try:
            transcript = transcribe_audio(wav_path)
        except Exception:
            transcript = None
        if not transcript:
            transcript = get_whisper().transcribe(wav_path)["text"]

        # Prefer an external LLM (if configured) for better summaries + reminders.
        reminders = []
        try:
            analysis = summarize_and_extract(transcript)
        except Exception:
            # If the external LLM is misconfigured (bad key/model/permissions),
            # fall back to local summarization rather than failing the request.
            analysis = None
        if analysis:
            raw_summary = analysis.get("summary")
            if isinstance(raw_summary, list):
                summary = "\n".join(f"- {item}" for item in raw_summary if item).strip()
            else:
                summary = (raw_summary or "").strip() 
            
            if not summary:
                summary = "No summary available."
                
            reminders = analysis.get("reminders") or []
        else:
            tokenizer, summary_model = get_summarizer()
            inputs = tokenizer(
                transcript,
                return_tensors="pt",
                truncation=True,
                max_length=1024
            )

            summary_ids = summary_model.generate(
                inputs["input_ids"],
                max_length=90,
                min_length=25,
                num_beams=6,
                no_repeat_ngram_size=3,
                length_penalty=1.1,
            )

            summary = tokenizer.decode(
                summary_ids[0],
                skip_special_tokens=True
            )
            reminders = extract_reminders_fallback(transcript)

        normalized_reminders = []
        for reminder in reminders:
            title = clean_reminder_title(reminder.get("title", ""))
            if not title:
                continue
            normalized_reminders.append({
                "title": title,
                "due_at": reminder.get("due_at")
            })

        entry = save_to_db(person_name, transcript, summary)

        os.remove(raw_path)
        os.remove(wav_path)

        return {
            "entry": entry,
            # Option 3 flow: suggest reminders, but only save after user confirmation.
            "suggested_reminders": normalized_reminders,
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/diary-entries")
async def get_diary_entries():
    """
    Fetch all conversations from the database, ordered by newest first.
    """
    try:
        conn = sqlite3.connect("caremate.db")
        conn.row_factory = sqlite3.Row  # To return dict-like objects
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, person_name, transcript, summary, created_at FROM conversations ORDER BY created_at DESC"
        )
        rows = cursor.fetchall()
        
        entries = []
        for row in rows:
            entries.append(dict(row))
            
        conn.close()
        return {"entries": entries}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/diary-entries/{entry_id}")
async def delete_diary_entry(entry_id: int):
    """
    Delete a conversation entry by id.
    """
    try:
        conn = sqlite3.connect("caremate.db")
        cursor = conn.cursor()
        cursor.execute("DELETE FROM conversations WHERE id = ?", (entry_id,))
        deleted = cursor.rowcount
        conn.commit()
        conn.close()
        if deleted == 0:
            raise HTTPException(status_code=404, detail="Diary entry not found.")
        return {"message": "Diary entry deleted.", "id": entry_id}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/contacts")
async def get_contacts():
    """
    Return a list of known contacts. For now, this returns a mocked list 
    that was originally on the frontend, but we could eventually read this 
    from the database or the `known/` folder.
    """
    # Mock data to serve the frontend temporarily until DB is expanded
    mock_contacts = [
      { "id": 1, "name": "Priya", "relationship": "Daughter", "phone": "+91 98765 43210", "lastSeen": "Today, 2:30 PM", "avatar": "P", "color": "#E8735A", "interactions": 24 },
      { "id": 2, "name": "Rajan", "relationship": "Son", "phone": "+91 87654 32109", "lastSeen": "Yesterday", "avatar": "R", "color": "#5B8CF5", "interactions": 18 },
      { "id": 3, "name": "Dr. Sharma", "relationship": "Doctor", "phone": "+91 76543 21098", "lastSeen": "Today, 10:15 AM", "avatar": "D", "color": "#3B9E8E", "interactions": 9 },
      { "id": 4, "name": "Meena Aunty", "relationship": "Neighbour", "phone": "+91 65432 10987", "lastSeen": "3 days ago", "avatar": "M", "color": "#F5A623", "interactions": 12 },
    ]
    return {"contacts": mock_contacts}


@app.get("/faces")
async def get_faces():
    return {"faces": list_known_faces()}


@app.get("/faces/{person_name}/image")
async def get_face_image(person_name: str):
    path = resolve_known_face_path(person_name)
    if not path:
        raise HTTPException(status_code=404, detail=f"Face '{person_name}' not found.")
    return FileResponse(path)


@app.patch("/faces/{person_name}")
async def rename_face(person_name: str, request: Request):
    try:
        body = await request.json()
        new_name = (body.get("new_name") or "").strip()
        if not new_name:
            raise HTTPException(status_code=400, detail="new_name is required.")
        old_path = resolve_known_face_path(person_name)
        if not old_path:
            raise HTTPException(status_code=404, detail=f"Face '{person_name}' not found.")
        ext = os.path.splitext(old_path)[1]
        new_path = os.path.join(KNOWN_DIR, f"{new_name}{ext}")
        if os.path.exists(new_path):
            raise HTTPException(status_code=409, detail=f"Face '{new_name}' already exists.")
        os.rename(old_path, new_path)
        return {"message": "Face renamed successfully.", "name": new_name}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/faces/{person_name}")
async def delete_face(person_name: str):
    try:
        path = resolve_known_face_path(person_name)
        if not path:
            raise HTTPException(status_code=404, detail=f"Face '{person_name}' not found.")
        os.remove(path)
        return {"message": "Face deleted successfully.", "name": person_name}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.put("/faces/{person_name}/photo")
async def update_face_photo(person_name: str, file: UploadFile = File(...)):
    try:
        existing = resolve_known_face_path(person_name)
        if not existing:
            raise HTTPException(status_code=404, detail=f"Face '{person_name}' not found.")
        save_face_image(person_name, file)
        return {"message": "Face photo updated successfully.", "name": person_name}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/reminders")
async def get_reminders():
    """
    Fetch reminders ordered by newest first.
    """
    try:
        conn = sqlite3.connect("caremate.db")
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, title, due_at, status, conversation_id, created_at FROM reminders ORDER BY created_at DESC"
        )
        rows = cursor.fetchall()
        conn.close()
        return {"reminders": [dict(r) for r in rows]}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/reminders")
async def create_reminder(request: Request):
    """
    Create a reminder.
    Body: { title: str, due_at?: str|null, conversation_id?: int|null }
    """
    try:
        body = await request.json()
        title = (body.get("title") or "").strip()
        due_at = body.get("due_at")
        conversation_id = body.get("conversation_id")
        if not title:
            raise HTTPException(status_code=400, detail="title is required.")
        reminder = save_reminder(title, due_at, conversation_id)
        return {"reminder": reminder}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.patch("/reminders/{reminder_id}")
async def update_reminder(reminder_id: int, request: Request):
    """
    Update a reminder.
    Body: { status?: 'pending'|'done' }
    """
    try:
        body = await request.json()
        status = (body.get("status") or "").strip().lower()
        if status not in {"pending", "done"}:
            raise HTTPException(status_code=400, detail="status must be 'pending' or 'done'.")

        conn = sqlite3.connect("caremate.db")
        cursor = conn.cursor()
        cursor.execute("UPDATE reminders SET status = ? WHERE id = ?", (status, reminder_id))
        if cursor.rowcount == 0:
            conn.close()
            raise HTTPException(status_code=404, detail="Reminder not found.")
        cursor.execute(
            "SELECT id, title, due_at, status, conversation_id, created_at FROM reminders WHERE id = ?",
            (reminder_id,),
        )
        row = cursor.fetchone()
        conn.commit()
        conn.close()
        return {
            "reminder": {
                "id": row[0],
                "title": row[1],
                "due_at": row[2],
                "status": row[3],
                "conversation_id": row[4],
                "created_at": row[5],
            }
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/reminders/{reminder_id}")
async def delete_reminder(reminder_id: int):
    """
    Delete a reminder by id.
    """
    try:
        conn = sqlite3.connect("caremate.db")
        cursor = conn.cursor()
        cursor.execute("DELETE FROM reminders WHERE id = ?", (reminder_id,))
        if cursor.rowcount == 0:
            conn.close()
            raise HTTPException(status_code=404, detail="Reminder not found.")
        conn.commit()
        conn.close()
        return {"message": "Reminder deleted.", "id": reminder_id}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/verify-face/{person_name}")
async def verify_face_endpoint(person_name: str, file: UploadFile = File(...)):
    """
    Verify whether the uploaded face matches the known face for a given person.
    """
    known_image_path = resolve_known_face_path(person_name)
    if not known_image_path:
        raise HTTPException(
            status_code=404,
            detail=f"No known image found for '{person_name}'. "
                   f"Please register from Faces section first."
        )

    current_image_path = os.path.join(TEMP_UPLOAD_DIR, "current.jpg")

    try:
        with open(current_image_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        result = verify_face(known_image_path, current_image_path)

        return {
            "person": person_name,
            "verified": result["verified"],
            "distance": result["distance"],
            "threshold": result["threshold"],
            "model": result["model"],
            "similarity_metric": result["similarity_metric"]
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    finally:
        if os.path.exists(current_image_path):
            os.remove(current_image_path)


@app.post("/register-face/{person_name}")
async def register_face(person_name: str, file: UploadFile = File(...)):
    """
    Register a new known face by saving the uploaded image to the `known/` folder.
    """
    try:
        save_face_image(person_name, file)

        return {"message": f"Face registered successfully for '{person_name}'."}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/identify-face")
async def identify_face(file: UploadFile = File(...)):
    """
    Identify a person by comparing uploaded face against all known faces.
    """
    faces = list_known_faces()
    if not faces:
        raise HTTPException(status_code=404, detail="No faces registered yet.")

    upload_path = os.path.join(TEMP_UPLOAD_DIR, "identify_current.jpg")
    try:
        with open(upload_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        best_match = None
        best_distance = None

        for face in faces:
            known_path = os.path.join(KNOWN_DIR, face["filename"])
            result = verify_face(known_path, upload_path)
            distance = float(result.get("distance", 9999))
            if best_distance is None or distance < best_distance:
                best_distance = distance
                best_match = {
                    "person": face["name"],
                    "verified": bool(result.get("verified")),
                    "distance": distance,
                    "threshold": float(result.get("threshold", 0.0)),
                    "model": result.get("model"),
                    "similarity_metric": result.get("similarity_metric"),
                }

        if not best_match:
            return {"person": "Unknown", "verified": False}
        return best_match
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if os.path.exists(upload_path):
            os.remove(upload_path)


@app.post("/webcam-verify")
async def webcam_verify(request: Request):
    """
    Accepts a JSON body with:
      - person_name: str
      - image: base64-encoded JPEG string (from webcam capture)
    Verifies the webcam image against the known face.
    """
    body = await request.json()
    person_name = body.get("person_name", "").strip()
    image_data = body.get("image", "")

    if not person_name:
        raise HTTPException(status_code=400, detail="person_name is required.")
    if not image_data:
        raise HTTPException(status_code=400, detail="image data is required.")

    known_image_path = resolve_known_face_path(person_name)
    if not known_image_path:
        raise HTTPException(
            status_code=404,
            detail=f"No known image found for '{person_name}'. Please register first."
        )

    # Strip base64 header if present (e.g. "data:image/jpeg;base64,...")
    if "," in image_data:
        image_data = image_data.split(",")[1]

    current_image_path = os.path.join(TEMP_UPLOAD_DIR, "webcam_current.jpg")

    try:
        with open(current_image_path, "wb") as f:
            f.write(base64.b64decode(image_data))

        result = verify_face(known_image_path, current_image_path)

        return {
            "person": person_name,
            "verified": result["verified"],
            "distance": round(result["distance"], 4),
            "threshold": round(result["threshold"], 4),
            "model": result["model"],
            "similarity_metric": result["similarity_metric"]
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    finally:
        if os.path.exists(current_image_path):
            os.remove(current_image_path)


@app.get("/webcam", response_class=HTMLResponse)
async def webcam_page():
    """
    Serves a simple webcam page to capture and verify a face live.
    Open http://127.0.0.1:8000/webcam in your browser.
    """
    html = """
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8"/>
      <title>CareMate - Webcam Verify</title>
      <style>
        body { font-family: sans-serif; background: #0f0f0f; color: #eee;
               display: flex; flex-direction: column; align-items: center; padding: 40px; }
        h1   { margin-bottom: 8px; color: #4fc3f7; }
        p    { color: #888; margin-bottom: 24px; }
        input { padding: 10px 14px; border-radius: 8px; border: 1px solid #333;
                background: #1a1a1a; color: #eee; font-size: 15px;
                margin-bottom: 16px; width: 300px; }
        video, canvas { border-radius: 12px; border: 2px solid #1f2330; margin: 10px 0; }
        button { padding: 12px 28px; border-radius: 8px; border: none; cursor: pointer;
                 font-size: 15px; font-weight: 600; margin: 6px; transition: opacity 0.2s; }
        button:hover { opacity: 0.85; }
        #startBtn   { background: #4fc3f7; color: #000; }
        #captureBtn { background: #a78bfa; color: #fff; }
        #verifyBtn  { background: #6ee7b7; color: #000; }
        #result { margin-top: 24px; padding: 20px 28px; border-radius: 12px;
                  background: #1a1a1a; border: 1px solid #2a2a2a; font-size: 16px;
                  min-width: 300px; text-align: center; display: none; }
        .success { color: #4ade80; font-size: 22px; font-weight: 700; }
        .fail    { color: #f87171; font-size: 22px; font-weight: 700; }
        .detail  { color: #888; font-size: 13px; margin-top: 8px; }
      </style>
    </head>
    <body>
      <h1>🎥 CareMate — Webcam Verify</h1>
      <p>Use your webcam to verify your identity in real time.</p>

      <input type="text" id="personName" placeholder="Enter registered name (e.g. rahul)" />
      <br/>

      <button id="startBtn" onclick="startCamera()">▶ Start Camera</button>
      <br/>

      <video id="video" width="400" height="300" autoplay style="display:none"></video>
      <canvas id="canvas" width="400" height="300" style="display:none"></canvas>
      <br/>

      <button id="captureBtn" onclick="capture()" style="display:none">📸 Capture Photo</button>
      <button id="verifyBtn" onclick="verify()" style="display:none">✅ Verify Face</button>

      <div id="result"></div>

      <script>
        let stream = null;
        let capturedImage = null;

        async function startCamera() {
          const video = document.getElementById('video');
          stream = await navigator.mediaDevices.getUserMedia({ video: true });
          video.srcObject = stream;
          video.style.display = 'block';
          document.getElementById('captureBtn').style.display = 'inline-block';
          document.getElementById('startBtn').style.display = 'none';
        }

        function capture() {
          const video  = document.getElementById('video');
          const canvas = document.getElementById('canvas');
          const ctx    = canvas.getContext('2d');
          ctx.drawImage(video, 0, 0, 400, 300);
          canvas.style.display = 'block';
          capturedImage = canvas.toDataURL('image/jpeg');
          document.getElementById('verifyBtn').style.display = 'inline-block';
          document.getElementById('captureBtn').textContent = '🔄 Retake';
          if (stream) stream.getTracks().forEach(t => t.stop());
          video.style.display = 'none';
        }

        async function verify() {
          const name = document.getElementById('personName').value.trim();
          if (!name)          { alert('Please enter your registered name first!'); return; }
          if (!capturedImage) { alert('Please capture a photo first!'); return; }

          const resultDiv = document.getElementById('result');
          resultDiv.style.display = 'block';
          resultDiv.innerHTML = '⏳ Verifying... please wait';

          const response = await fetch('/webcam-verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ person_name: name, image: capturedImage })
          });

          const data = await response.json();

          if (response.ok) {
            if (data.verified) {
              resultDiv.innerHTML = `
                <div class="success">✅ Identity Verified!</div>
                <div class="detail">Matched: <b>${data.person}</b></div>
                <div class="detail">Distance: ${data.distance} / Threshold: ${data.threshold}</div>
              `;
            } else {
              resultDiv.innerHTML = `
                <div class="fail">❌ Not Verified</div>
                <div class="detail">Face did not match <b>${data.person}</b></div>
                <div class="detail">Distance: ${data.distance} / Threshold: ${data.threshold}</div>
              `;
            }
          } else {
            resultDiv.innerHTML = `<div class="fail">⚠️ Error: ${data.detail}</div>`;
          }
        }
      </script>
    </body>
    </html>
    """
    return HTMLResponse(content=html)
