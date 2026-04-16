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

## Backend Setup
```bash
cd CAREMATE
python3.11 -m venv venv
source venv/bin/activate
python -m pip install -r requirements.txt
python init_db.py
uvicorn main:app --reload
```

## Frontend Setup
```bash
cd caremate_front
npm install
npm run dev
```
