import io
import subprocess
import wave
from pathlib import Path

from flask import Flask, jsonify, request, send_file
from piper import PiperVoice

VOICE_PATH = Path("/app/voices/en_US-joe-medium.onnx")
MAX_TEXT_LENGTH = 40_000

# Piper's synthesize_wav() concatenates one audio chunk per detected
# sentence with no silence between them, which is why the raw output reads
# like a wall of text instead of an audiobook. We insert pauses ourselves:
# a short one between sentences, a longer one between paragraphs/headings.
SENTENCE_SILENCE_S = 0.35
PARAGRAPH_SILENCE_S = 0.65

app = Flask(__name__)
voice = PiperVoice.load(str(VOICE_PATH))


def _silence_bytes(seconds, sample_rate, sample_width):
    n_samples = int(seconds * sample_rate)
    return b"\x00" * (n_samples * sample_width)


def synthesize_paragraphs(paragraphs):
    sample_rate = voice.config.sample_rate
    sample_width = 2  # int16, per PiperVoice.synthesize()
    sentence_silence = _silence_bytes(SENTENCE_SILENCE_S, sample_rate, sample_width)
    paragraph_silence = _silence_bytes(PARAGRAPH_SILENCE_S, sample_rate, sample_width)

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav_file:
        wav_file.setframerate(sample_rate)
        wav_file.setsampwidth(sample_width)
        wav_file.setnchannels(1)

        for i, paragraph in enumerate(paragraphs):
            for chunk in voice.synthesize(paragraph):
                wav_file.writeframes(chunk.audio_int16_bytes)
                wav_file.writeframes(sentence_silence)
            if i < len(paragraphs) - 1:
                wav_file.writeframes(paragraph_silence)

    return buf.getvalue()


def wav_to_mp3(wav_bytes):
    # Raw Piper output is uncompressed 22kHz WAV (~55MB for a long article) -
    # far too large to comfortably stream to a phone. Speech doesn't need
    # much bitrate, so a mono 64kbps MP3 cuts that down substantially with
    # no perceptible quality loss for narration.
    result = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-i", "pipe:0",
            "-ac", "1", "-b:a", "64k", "-f", "mp3", "pipe:1",
        ],
        input=wav_bytes,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
    )
    return result.stdout


@app.get("/health")
def health():
    return jsonify({"status": "ok"})


@app.post("/synthesize")
def synthesize():
    data = request.get_json(silent=True) or {}
    texts = data.get("texts")
    if not isinstance(texts, list):
        return jsonify({"error": "texts (list of strings) is required"}), 400

    paragraphs = [t.strip() for t in texts if isinstance(t, str) and t.strip()]
    if not paragraphs:
        return jsonify({"error": "texts (list of strings) is required"}), 400
    if sum(len(p) for p in paragraphs) > MAX_TEXT_LENGTH:
        return jsonify({"error": "text too long"}), 400

    wav_bytes = synthesize_paragraphs(paragraphs)

    try:
        mp3_bytes = wav_to_mp3(wav_bytes)
    except subprocess.CalledProcessError:
        return jsonify({"error": "encoding failed"}), 500

    return send_file(io.BytesIO(mp3_bytes), mimetype="audio/mpeg")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
