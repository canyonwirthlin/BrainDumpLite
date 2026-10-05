"""faster-whisper decodes audio through PyAV; a PyAV release that drops an
argument it passes breaks every transcription (happened with av 19)."""
import io
import math
import struct
import wave

import pytest

pytest.importorskip("faster_whisper")


def test_decode_audio_works_with_installed_pyav():
    from faster_whisper.audio import decode_audio

    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"".join(struct.pack("<h", int(3000 * math.sin(i / 20))) for i in range(16000)))
    buf.seek(0)
    assert len(decode_audio(buf)) > 0
