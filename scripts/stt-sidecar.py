# /// script
# requires-python = ">=3.10"
# dependencies = ["faster-whisper>=1.0.3", "numpy>=1.24"]
# ///
"""
The speech server Stoke's dictation talks to.

Stoke never bundles this and never starts it. `remote.sttUrl` points at
whatever is listening, and both dictation paths - the phone and the desktop -
proxy through the main process to it, so the sidecar itself is never exposed
to the network and needs no authentication of its own. That is also why it
binds loopback by default: it has no auth, so it must not be reachable.

Run it:

    uv run scripts/stt-sidecar.py

`uv` resolves the two dependencies above into an ephemeral environment, so
there is no virtualenv to create and nothing to add to the repo's own
dependencies. The model downloads to ~/.cache/huggingface on first run.

The wire contract is fixed by the callers, not chosen here:

    POST /transcribe
    content-type: audio/wav       16-bit PCM, mono, 16 kHz, RIFF
    -> 200 {"text": "..."}        the transcript, "" when nothing was said
    -> 400 {"error": "..."}       not audio this server can read
    -> 500 {"error": "..."}       transcription itself failed

`src/main/remote/server.ts` posts exactly that and reads `text`;
`src/shared/voice.ts` produces exactly that WAV in the browser, because doing
the conversion here would mean shipping ffmpeg. GET / answers a small JSON
health blob so "is the sidecar up?" is answerable with curl.
"""

from __future__ import annotations

import argparse
import io
import json
import logging
import sys
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

# Matches the cap in src/main/remote/server.ts, so a body this server would
# refuse is one the proxy already refused - one limit, stated twice, rather
# than two limits that can disagree.
MAX_BODY = 25 * 1024 * 1024

# What the browser side encodes to (src/shared/voice.ts). Asserted rather than
# resampled: a mismatch means the caller changed and should fail loudly here,
# not be silently papered over into a worse transcript.
EXPECTED_RATE = 16_000

log = logging.getLogger("stt")


class Transcriber:
    """Wraps the model. One at a time, because the model is not reentrant."""

    def __init__(self, model_name: str, device: str, compute_type: str, language: str | None):
        from faster_whisper import WhisperModel

        self.language = language
        self._lock = threading.Lock()
        log.info("loading %s on %s (%s)...", model_name, device, compute_type)
        self._model = WhisperModel(model_name, device=device, compute_type=compute_type)
        log.info("ready")

    def __call__(self, audio: np.ndarray) -> str:
        with self._lock:
            segments, _ = self._model.transcribe(
                audio,
                language=self.language,
                # Dictation is one utterance, not a recording to index. Trimming
                # silence keeps whisper from hallucinating filler into the gaps
                # at either end, which is its most common failure on short
                # push-to-talk clips.
                vad_filter=True,
                condition_on_previous_text=False,
            )
            return "".join(segment.text for segment in segments).strip()


def decode_wav(raw: bytes) -> np.ndarray:
    """
    RIFF bytes -> mono float32 in [-1, 1], which is what faster-whisper wants.

    Raises ValueError with a message meant for a human reading a 400.
    """
    try:
        with wave.open(io.BytesIO(raw), "rb") as wav:
            channels = wav.getnchannels()
            width = wav.getsampwidth()
            rate = wav.getframerate()
            frames = wav.readframes(wav.getnframes())
    except (wave.Error, EOFError) as err:
        # EOFError carries no message, so `{err}` alone renders as "not a
        # readable WAV: " with nothing after the colon - which is what a body
        # too short to hold a RIFF header produces, i.e. the most likely case.
        # `str(err) or ...`, not `err or ...`: an exception object has no
        # __bool__, so it is always truthy and the fallback would never fire.
        raise ValueError(f"not a readable WAV: {str(err) or type(err).__name__}") from err

    if width != 2:
        raise ValueError(f"expected 16-bit samples, got {width * 8}-bit")
    if rate != EXPECTED_RATE:
        raise ValueError(f"expected {EXPECTED_RATE} Hz, got {rate} Hz")
    if not frames:
        return np.zeros(0, dtype=np.float32)

    samples = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        # Averaging rather than taking channel 0: a caller that sent stereo
        # probably has real signal in both, and dropping one halves it.
        samples = samples.reshape(-1, channels).mean(axis=1)
    return samples


class Handler(BaseHTTPRequestHandler):
    server_version = "stoke-stt/1.0"
    transcribe: Transcriber  # set on the class in main()

    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's spelling
        if self.path.rstrip("/") in ("", "/health"):
            return self._send(200, {"ok": True, "service": "stoke-stt"})
        self._send(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path.rstrip("/") != "/transcribe":
            return self._send(404, {"error": "not found"})

        try:
            length = int(self.headers.get("content-length") or 0)
        except ValueError:
            return self._send(400, {"error": "bad content-length"})
        if length <= 0:
            return self._send(400, {"error": "empty body"})
        if length > MAX_BODY:
            return self._send(400, {"error": "recording too large"})

        raw = self.rfile.read(length)
        if len(raw) != length:
            return self._send(400, {"error": "truncated body"})

        try:
            audio = decode_wav(raw)
        except ValueError as err:
            return self._send(400, {"error": str(err)})

        # Under a tenth of a second is a mis-tap. The browser already drops
        # these, but the phone's check is on compressed bytes and cannot be
        # exact; this one is on samples and is.
        if audio.size < EXPECTED_RATE // 10:
            return self._send(200, {"text": ""})

        try:
            text = self.transcribe(audio)
        except Exception as err:  # noqa: BLE001 - a 500 must never be a traceback
            log.exception("transcription failed")
            return self._send(500, {"error": f"transcription failed: {err}"})

        log.info("%.1fs -> %d chars", audio.size / EXPECTED_RATE, len(text))
        self._send(200, {"text": text})

    def log_message(self, fmt: str, *args) -> None:
        log.debug(fmt, *args)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="127.0.0.1", help="bind address (default: loopback only)")
    ap.add_argument("--port", type=int, default=17890, help="matches remote.sttUrl's default")
    ap.add_argument(
        "--model",
        default="small.en",
        help="faster-whisper model. base.en is quicker to fetch, small.en is "
        "noticeably better on code words and names (default: small.en)",
    )
    ap.add_argument("--device", default="auto", help="auto, cpu or cuda")
    ap.add_argument(
        "--compute-type",
        default="int8",
        help="int8 is the right default on Apple Silicon; float16 suits a CUDA box",
    )
    ap.add_argument(
        "--language",
        default="en",
        help="pass an empty string to let whisper detect it, at some latency cost",
    )
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    if args.host not in ("127.0.0.1", "localhost", "::1"):
        # Not refused - a LAN or tailnet bind is exactly how the Windows box
        # serves this Mac - but it must be a decision, not a default someone
        # copied. This server has no authentication whatsoever.
        log.warning("binding %s: this server has NO auth. Do not expose it beyond a trusted network.", args.host)

    Handler.transcribe = Transcriber(args.model, args.device, args.compute_type, args.language or None)

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    log.info("listening on http://%s:%d  (POST /transcribe)", args.host, args.port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("stopping")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
