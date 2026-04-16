# CareMate Backend

FastAPI backend for CareMate.

## Quick Start
```bash
python3.11 -m venv venv
source venv/bin/activate
python -m pip install -r requirements.txt
python init_db.py
uvicorn main:app --reload
```

## AI-First Pipeline (With Fallback)
- If configured, backend uses AI provider for:
  - transcription (`CARE_TRANSCRIBE_*`)
  - summary + reminder suggestion (`CARE_LLM_*`)
- If AI fails or is not configured, fallback is:
  - local Whisper transcription
  - local summarization + reminder extraction

## Configure Providers
1. Copy env template:
```bash
cp .env.example .env
```
2. Fill `.env` with provider values.
3. For direct Gemini setup (no OpenAI-compatible layer):
```env
CARE_LLM_PROVIDER=gemini
CARE_LLM_API_KEY=YOUR_KEY
CARE_LLM_MODEL=gemini-2.5-flash-lite

# optional API-first transcription
CARE_TRANSCRIBE_PROVIDER=gemini
CARE_TRANSCRIBE_API_KEY=YOUR_KEY
CARE_TRANSCRIBE_MODEL=gemini-2.5-flash-lite
```
3. Restart backend:
```bash
uvicorn main:app --reload
```

See the repo root `README.md` for full project setup.
