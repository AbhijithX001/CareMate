# CareMate

CareMate is an assistive application for Alzheimer’s care.

## Features
- Speech-to-text using OpenAI Whisper
- Conversation summarization using Transformer models or an optional LLM
- SQLite database for storing interactions
- Standalone face recognition module (DeepFace)
- React + Vite frontend

## Structure
- `CAREMATE/` backend (FastAPI)
- `caremate_front/` frontend (React + Vite)

## Requirements
- Python `3.11.x` (recommended: `3.11.14`)
- Node.js + npm (for frontend)

## Backend Setup (FastAPI)
```bash
cd CAREMATE
python3.11 -m venv venv
source venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python init_db.py
uvicorn main:app --reload
```

Backend runs at: `http://127.0.0.1:8000`

## Frontend Setup (Vite)
```bash
cd caremate_front
npm install
npm run dev -- --host 127.0.0.1 --port 5173
```

Frontend runs at: `http://127.0.0.1:5173`

## Run Both (Two Terminals)
Terminal 1:
```bash
cd CAREMATE
source venv/bin/activate
uvicorn main:app --reload
```

Terminal 2:
```bash
cd caremate_front
npm run dev -- --host 127.0.0.1 --port 5173
```

## Notes
- Run `npm` commands only inside `caremate_front/`.
- Run backend Python commands only inside `CAREMATE/`.
- If VS Code picks the wrong Python interpreter, select:
  `CAREMATE/venv/bin/python`
