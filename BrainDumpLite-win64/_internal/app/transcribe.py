"""Local voice transcription via faster-whisper (optional dependency).

Audio never leaves the machine regardless of which chat provider is set.
Model files download to the data dir on first use (~75 MB for 'base').
If faster-whisper isn't installed/bundled, available() is False and the UI
hides the mic button.
"""
from __future__ import annotations

import io
import threading

from . import db

_model = None          # (size, WhisperModel)
_lock = threading.Lock()


def available() -> bool:
    try:
        import faster_whisper  # noqa: F401
        return True
    except Exception:
        return False


def transcribe_bytes(data: bytes) -> str:
    from faster_whisper import WhisperModel

    global _model
    size = db.get_setting("whisper_model", "base")
    with _lock:
        if _model is None or _model[0] != size:
            _model = (size, WhisperModel(
                size, device="cpu", compute_type="int8",
                download_root=str(db.data_dir() / "models")))
        model = _model[1]
    segments, _info = model.transcribe(io.BytesIO(data), beam_size=1, vad_filter=False)
    return " ".join(s.text.strip() for s in segments).strip()
