import json
import os
import mimetypes
import base64
from typing import Any, Dict, List, Optional

import requests


def _env(name: str) -> str:
    return (os.getenv(name) or "").strip()


def _openai_compat_chat(
    *,
    base_url: str,
    api_key: str,
    model: str,
    messages: List[Dict[str, Any]],
    temperature: float = 0.2,
) -> str:
    """
    Minimal OpenAI-compatible Chat Completions call.
    Works with providers that expose /chat/completions with Bearer auth.
    """
    url = base_url.rstrip("/") + "/chat/completions"
    headers = {"Content-Type": "application/json"}
    # Some OpenAI-compatible servers (e.g. local Ollama) don't require auth.
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
    }
    resp = requests.post(url, headers=headers, json=payload, timeout=60)
    resp.raise_for_status()
    data = resp.json()
    return data["choices"][0]["message"]["content"]


def _gemini_generate_text(
    *,
    api_key: str,
    model: str,
    prompt: str,
    temperature: float = 0.2,
) -> str:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    params = {"key": api_key}
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": temperature},
    }
    resp = requests.post(url, params=params, json=payload, timeout=90)
    resp.raise_for_status()
    data = resp.json()
    parts = (((data.get("candidates") or [{}])[0]).get("content") or {}).get("parts") or []
    text_chunks = [p.get("text", "") for p in parts if isinstance(p, dict)]
    return "\n".join([c for c in text_chunks if c]).strip()


def _openai_compat_transcribe(
    *,
    base_url: str,
    api_key: str,
    model: str,
    audio_path: str,
) -> str:
    """
    Minimal OpenAI-compatible Audio Transcriptions call.
    """
    url = base_url.rstrip("/") + "/audio/transcriptions"
    headers = {}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    mime_type = mimetypes.guess_type(audio_path)[0] or "audio/wav"
    with open(audio_path, "rb") as file_obj:
        files = {"file": (os.path.basename(audio_path), file_obj, mime_type)}
        data = {"model": model}
        resp = requests.post(url, headers=headers, files=files, data=data, timeout=120)
        resp.raise_for_status()
        payload = resp.json()
    text = (payload.get("text") or "").strip()
    return text


def _gemini_transcribe(
    *,
    api_key: str,
    model: str,
    audio_path: str,
) -> str:
    mime_type = mimetypes.guess_type(audio_path)[0] or "audio/wav"
    with open(audio_path, "rb") as file_obj:
        audio_b64 = base64.b64encode(file_obj.read()).decode("utf-8")

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    params = {"key": api_key}
    payload = {
        "contents": [
            {
                "parts": [
                    {"text": "Transcribe this audio accurately. Return only plain transcription text."},
                    {"inline_data": {"mime_type": mime_type, "data": audio_b64}},
                ]
            }
        ],
        "generationConfig": {"temperature": 0},
    }
    resp = requests.post(url, params=params, json=payload, timeout=120)
    resp.raise_for_status()
    data = resp.json()
    parts = (((data.get("candidates") or [{}])[0]).get("content") or {}).get("parts") or []
    text_chunks = [p.get("text", "") for p in parts if isinstance(p, dict)]
    return "\n".join([c for c in text_chunks if c]).strip()


def _parse_model_json(content: str) -> Dict[str, Any]:
    cleaned = (content or "").strip()
    if cleaned.startswith("```"):
        # Remove fenced wrappers like ```json ... ```
        cleaned = cleaned.strip("`").strip()
        if cleaned.lower().startswith("json"):
            cleaned = cleaned[4:].strip()
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start != -1 and end != -1 and end > start:
        cleaned = cleaned[start : end + 1]
    data = json.loads(cleaned)
    if not isinstance(data, dict):
        raise ValueError("LLM response JSON must be an object.")
    data.setdefault("reminders", [])
    return data


def transcribe_audio(audio_path: str) -> Optional[str]:
    """
    Optional AI transcription. Returns text or None when not configured.
    Env:
      CARE_TRANSCRIBE_PROVIDER=openai_compat
      CARE_TRANSCRIBE_BASE_URL=...
      CARE_TRANSCRIBE_API_KEY=...
      CARE_TRANSCRIBE_MODEL=...
    """
    provider = _env("CARE_TRANSCRIBE_PROVIDER").lower()
    if not provider:
        return None
    api_key = _env("CARE_TRANSCRIBE_API_KEY")
    model = _env("CARE_TRANSCRIBE_MODEL")
    text = None

    if provider == "openai_compat":
        base_url = _env("CARE_TRANSCRIBE_BASE_URL")
        if not (base_url and model):
            raise ValueError("Missing CARE_TRANSCRIBE_BASE_URL / CARE_TRANSCRIBE_MODEL.")
        text = _openai_compat_transcribe(
            base_url=base_url,
            api_key=api_key,
            model=model,
            audio_path=audio_path,
        )
    elif provider == "gemini":
        if not (api_key and model):
            raise ValueError("Missing CARE_TRANSCRIBE_API_KEY / CARE_TRANSCRIBE_MODEL.")
        text = _gemini_transcribe(
            api_key=api_key,
            model=model,
            audio_path=audio_path,
        )
    else:
        raise ValueError("Unsupported CARE_TRANSCRIBE_PROVIDER. Use 'gemini' or 'openai_compat'.")

    return text or None


def summarize_and_extract(transcript: str) -> Optional[Dict[str, Any]]:
    """
    Returns dict with:
      - summary: str
      - reminders: [{title: str, due_at: str|None}]
    or None if not configured.
    """
    provider = _env("CARE_LLM_PROVIDER").lower()
    if not provider:
        return None

    api_key = _env("CARE_LLM_API_KEY")
    model = _env("CARE_LLM_MODEL")

    system = (
        "You are an assistant for an Alzheimer's-care app.\n"
        "Task: produce a high-quality summary and extract reminders from a conversation transcript.\n"
        "Return ONLY valid JSON with keys: summary, reminders.\n"
        "summary: 2-4 concise bullet points, each under 14 words.\n"
        "reminders: array of objects {title, due_at}. due_at is ISO-8601 datetime if known, else null.\n"
        "Reminder title rules: plain task phrase only, no greetings, no names unless necessary, no 'remind me', max 7 words.\n"
        "Do not invent dates; if the transcript says 'tomorrow 10am', convert relative time to ISO using the user's locale when possible.\n"
    )
    user = f"Transcript:\n{transcript}"

    if provider == "openai_compat":
        base_url = _env("CARE_LLM_BASE_URL")
        if not (base_url and model):
            raise ValueError("Missing CARE_LLM_BASE_URL / CARE_LLM_MODEL.")
        content = _openai_compat_chat(
            base_url=base_url,
            api_key=api_key,
            model=model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        )
        return _parse_model_json(content)

    if provider == "gemini":
        if not (api_key and model):
            raise ValueError("Missing CARE_LLM_API_KEY / CARE_LLM_MODEL.")
        prompt = f"{system}\n\n{user}\n\nReturn JSON only."
        content = _gemini_generate_text(
            api_key=api_key,
            model=model,
            prompt=prompt,
            temperature=0.2,
        )
        return _parse_model_json(content)

    raise ValueError("Unsupported CARE_LLM_PROVIDER. Use 'gemini' or 'openai_compat'.")
