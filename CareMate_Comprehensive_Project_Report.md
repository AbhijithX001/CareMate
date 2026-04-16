# CareMate: Comprehensive Technical Project Report (Current Working Model)

## 1. Project Snapshot
- Project: CareMate (assistive app for Alzheimer's care and memory support)
- Codebase snapshot date: 2026-03-30
- Architecture style: Client-server web app with AI-assisted processing and local persistence
- Primary runtime split:
  - Backend: Python + FastAPI + SQLite + ML/AI services
  - Frontend: React + Vite single-page app

This report is based on currently implemented source code and active environment configuration.

---

## 2. Current Working AI Model Configuration
From the active backend environment (`CAREMATE/.env`), the running AI setup is:

- `CARE_LLM_PROVIDER=gemini`
- `CARE_LLM_MODEL=gemini-2.5-flash-lite`
- `CARE_TRANSCRIBE_PROVIDER=gemini`
- `CARE_TRANSCRIBE_MODEL=gemini-2.5-flash-lite`

Implication:
- Conversation transcription is attempted through Gemini first.
- Summary + reminder extraction is attempted through Gemini first.
- If transcription fails or is unavailable, backend falls back to local Whisper (`base`).
- If summary extraction fails or is unavailable, backend falls back to local BART summarization + regex/dateparser reminder extraction.

---

## 3. High-Level Technical Architecture

## 3.1 Backend Layer (`CAREMATE/`)
Core files:
- `main.py` (832 lines): API routes, face pipeline, audio pipeline, reminder and diary CRUD
- `llm.py` (230 lines): provider abstraction for Gemini/OpenAI-compatible endpoints
- `database.py` (27 lines): SQLite schema creation
- `init_db.py`: schema bootstrap script

Core backend capabilities:
- Audio ingestion and conversion to WAV via FFmpeg
- AI-first transcription and summarization flow with local fallback
- Face registration, identification, and verification using DeepFace
- Reminder extraction/storage and state management
- Diary entry persistence and retrieval

## 3.2 Frontend Layer (`caremate_front/`)
Core files:
- `src/App.jsx` (700 lines): complete application flow in one file
- `src/main.jsx`: React root rendering
- `src/App.css`, `src/index.css`: design system and layout styling

Core frontend capabilities:
- Camera and microphone capture flow
- Face recognition-assisted person identification
- Conversation recording, backend processing trigger, and result rendering
- Diary browsing and deletion
- Face library management (add/delete/select)
- Reminder list management and completion toggle

---

## 4. Backend Technology Stack

## 4.1 Framework and Infra
- FastAPI (`fastapi==0.129.0`)
- Uvicorn (`uvicorn==0.41.0`)
- CORS middleware enabled (currently wildcard `*`)
- Multipart upload handling (`python-multipart`)

## 4.2 AI and ML
- Local STT fallback: `openai-whisper` with model `base`
- Local summarization fallback: `facebook/bart-large-cnn` (Transformers)
- Face recognition: `deepface` using ArcFace + MTCNN backend
- Cloud AI provider support:
  - Gemini via `generativelanguage.googleapis.com`
  - OpenAI-compatible APIs via configurable base URL

## 4.3 Data and Utilities
- SQLite for persistence (`caremate.db`)
- `python-dateutil` for due date parsing
- `requests` for provider API calls
- `ffmpeg` subprocess for audio normalization (16kHz mono WAV)

---

## 5. Frontend Technology Stack
- React 19
- Vite 8
- Axios for HTTP calls
- Framer Motion for stateful transitions/animations
- Lucide React icons
- CSS variable-driven custom visual system

Build/Dev scripts:
- `npm run dev` -> Vite dev server
- `npm run build` -> production bundle
- `npm run preview` -> preview built output

---

## 6. Data Model (SQLite)

## 6.1 `conversations`
Columns:
- `id` INTEGER PK AUTOINCREMENT
- `person_name` TEXT
- `transcript` TEXT
- `summary` TEXT
- `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP

## 6.2 `reminders`
Columns:
- `id` INTEGER PK AUTOINCREMENT
- `title` TEXT NOT NULL
- `due_at` TIMESTAMP NULLABLE
- `status` TEXT NOT NULL DEFAULT `pending`
- `conversation_id` INTEGER (FK -> conversations.id)
- `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP

Lifecycle:
- `init_db.py` initializes schema via `database.create_tables()`.

---

## 7. API Surface (Implemented)

## 7.1 Audio + Diary
- `POST /process-audio`
  - Inputs: multipart audio file + `person_name`
  - Pipeline:
    1. Save raw upload
    2. Convert to WAV
    3. Transcribe (Gemini/OpenAI-compatible), fallback Whisper
    4. Summarize + extract reminders (Gemini/OpenAI-compatible), fallback BART + heuristic extraction
    5. Save conversation entry
    6. Return saved entry + `suggested_reminders` (not auto-saved)
- `GET /diary-entries`
  - Returns all conversations ordered newest first
- `DELETE /diary-entries/{entry_id}`
  - Deletes one diary record

## 7.2 Reminders
- `GET /reminders`
  - Returns reminders ordered newest first
- `POST /reminders`
  - Creates reminder (`title`, optional `due_at`, optional `conversation_id`)
- `PATCH /reminders/{reminder_id}`
  - Updates `status` in `{pending, done}`

## 7.3 Face Library and Recognition
- `GET /faces`
  - Lists known face identities from `known/`
- `GET /faces/{person_name}/image`
  - Serves stored face image file
- `PATCH /faces/{person_name}`
  - Renames a face identity
- `DELETE /faces/{person_name}`
  - Deletes identity image
- `PUT /faces/{person_name}/photo`
  - Replaces identity image
- `POST /register-face/{person_name}`
  - Registers image for new/existing identity
- `POST /verify-face/{person_name}`
  - One-to-one verification against specified identity
- `POST /identify-face`
  - One-to-many matching against all known faces, returns best match
- `POST /webcam-verify`
  - Base64 webcam verify endpoint
- `GET /webcam`
  - Serves a simple HTML diagnostic webcam verification page

## 7.4 Contacts
- `GET /contacts`
  - Returns mocked contact list (not DB-backed)

---

## 8. End-to-End Runtime Flows

## 8.1 Memory Capture Flow
1. Frontend opens camera/mic via browser APIs.
2. Frontend captures still image and calls `/identify-face`.
3. If no verified match, frontend auto-registers unknown face with generated temporary name.
4. User records audio; frontend posts to `/process-audio`.
5. Backend processes audio + AI analysis + DB write.
6. Frontend displays summary and optional reminder suggestions.
7. Reminder is persisted only if user clicks Add.

## 8.2 Reminder Management Flow
1. Frontend loads reminders from `/reminders`.
2. Pending and done groups computed client-side.
3. Toggle action sends `PATCH /reminders/{id}` with new status.

## 8.3 Diary Flow
1. Frontend loads entries from `/diary-entries`.
2. Entry list + details rendered client-side.
3. Delete action sends `DELETE /diary-entries/{id}`.

---

## 9. Current Implementation Characteristics

## 9.1 Strengths
- AI-first with local fallback strategy improves reliability.
- Clear user-facing separation between suggested reminders and confirmed reminders.
- Face library CRUD and recognition endpoints are present and integrated with UI.
- Minimal deployment complexity due to SQLite and single FastAPI service.

## 9.2 Technical Debt / Risks
- `main.py` and `App.jsx` are monolithic; limited modular separation.
- CORS is fully open (`allow_origins=["*"]`), not production hardened.
- No authentication/authorization for API routes.
- No automated tests in backend or frontend.
- `caremate.db` exists in repository (stateful artifact in source tree).
- Contacts endpoint is mocked; not integrated with persistent model.
- Error handling is broad (`except Exception`) across many routes.
- Heavy ML dependencies (TensorFlow + Torch + DeepFace) increase environment footprint.

## 9.3 Performance Considerations
- Lazy loading of Whisper and BART reduces startup cost but first-request latency remains high.
- Face identification loops over all known faces sequentially; scales linearly with face count.
- Audio files are written to local disk and processed synchronously per request.

---

## 10. Security and Compliance Posture (Current State)
- Environment-based secret management is supported via `.env`.
- SQL injection exposure is low due to parameterized SQLite queries.
- Missing enterprise controls currently:
  - AuthN/AuthZ
  - Rate limiting
  - Request size limits/hard quotas
  - Audit logs and PII retention policies
  - Encryption-at-rest strategy beyond host defaults

Given healthcare-adjacent use cases, privacy and compliance hardening is recommended before production rollout.

---

## 11. Deployment and Operations Notes

Backend startup:
1. `cd CAREMATE`
2. create/activate virtualenv
3. `pip install -r requirements.txt`
4. `python init_db.py`
5. `uvicorn main:app --reload`

Frontend startup:
1. `cd caremate_front`
2. `npm install`
3. `npm run dev`

Configuration knobs:
- Frontend API target: `VITE_API_BASE_URL`
- AI providers/models: `CARE_LLM_*`, `CARE_TRANSCRIBE_*`

External runtime requirement:
- `ffmpeg` must be available on host PATH for `/process-audio` conversion.

---

## 12. Suggested Technical Roadmap (Priority Order)
1. Refactor monoliths:
   - Split backend by domain (`audio.py`, `faces.py`, `reminders.py`, `diary.py`)
   - Split frontend screens/components into separate modules
2. Add test coverage:
   - Backend API tests (FastAPI TestClient)
   - Frontend component/integration tests
3. Security hardening:
   - Token-based auth
   - Restricted CORS
   - Input/file validation guardrails
4. Reliability improvements:
   - Structured logging + request correlation IDs
   - Better exception taxonomy and error responses
5. Scalability enhancements:
   - Async/background task queue for long-running audio/AI jobs
   - Embedding/caching strategy for face recognition to avoid full pairwise checks
6. Data governance:
   - Retention policy, archival strategy, and encrypted backups for SQLite migration path

---

## 13. Final Technical Summary
CareMate currently runs as a pragmatic AI-enabled caregiving assistant with a fully functioning FastAPI backend and React frontend. The active production logic is Gemini-first for both transcription and conversation understanding, with robust local fallback paths for continuity. The codebase is functionally rich for an MVP/prototype stage, especially in face-aware memory capture and reminder workflows, and is now ready for a focused phase of modularization, test hardening, and security controls.
