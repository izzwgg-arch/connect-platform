#!/usr/bin/env python3
"""
Yiddish corpus — local faster-whisper transcription, run on the office PC's
own CPU — or its NVIDIA GPU with --device cuda (Izzy's Dell, 2026-09-17).
$0 per minute; the only cost is wall time.

Invoked by LocalFasterWhisperBackend (transcribeBackend.ts) as:

    <python> local_whisper.py --model <model> --compute <compute>
             --threads <threads> --device <cpu|cuda> --language yi <audioPath>

Contract with the Node caller:
  - Exactly ONE JSON object is printed on stdout, and nothing else. All
    progress/diagnostic text goes to stderr.
  - Exit code 0 on success. Any non-zero exit means the Node side treats the
    chunk as failed (one bad chunk must never crash the whole item).

`--self-check` is a second, human-run mode: it imports faster_whisper and
exits, without loading a model or touching any audio, so a slow box can prove
the script and its environment are wired correctly without waiting out a real
transcription (which can be tens of minutes on a CPU with no GPU). Never used
by LocalFasterWhisperBackend itself — only by a person validating a box.

Output shape:
    {
      "model": "<model name faster-whisper reports>",
      "language": "<detected/forced language>",
      "duration": <float seconds>,
      "segments": [
        {
          "start": <float>, "end": <float>, "text": "...",
          "avg_logprob": <float>, "no_speech_prob": <float>,
          "words": [{"word": "...", "start": <float>, "end": <float>, "probability": <float>}]
        },
        ...
      ]
    }

⛔ This script must never mention Yiddish Labs, in any form. A guard test in
transcribeBackend.test.ts reads this file's source for exactly that.
"""

import argparse
import json
import sys


def eprint(*args, **kwargs):
    print(*args, file=sys.stderr, **kwargs)
    sys.stderr.flush()


def main() -> int:
    parser = argparse.ArgumentParser(description="Local faster-whisper transcription (CPU, $0/minute).")
    parser.add_argument("--model", help="faster-whisper / CTranslate2 model id or local path")
    parser.add_argument("--compute", default="int8", help="CTranslate2 compute type (default int8)")
    parser.add_argument("--threads", type=int, default=8, help="CPU threads (default 8)")
    parser.add_argument("--device", default="cpu", help="CTranslate2 device: cpu (default) or cuda (NVIDIA GPU)")
    parser.add_argument("--language", default="yi", help="forced language code (default yi — never he, never auto)")
    parser.add_argument(
        "--self-check",
        action="store_true",
        help="import faster_whisper and exit 0 — no model load, no audio, no transcription",
    )
    parser.add_argument("audio_path", nargs="?", help="path to the audio file to transcribe")
    args = parser.parse_args()

    # On Windows, CUDA/cuDNN runtime DLLs installed through pip (nvidia-cublas-cu12,
    # nvidia-cudnn-cu12) live inside site-packages and are NOT on PATH. The Node
    # caller (or a person) puts their folders in YC_CUDA_BIN, ';'-separated.
    import os
    for d in (os.environ.get("YC_CUDA_BIN") or "").split(";"):
        d = d.strip()
        if d and os.path.isdir(d):
            try:
                os.add_dll_directory(d)  # type: ignore[attr-defined]
            except (AttributeError, OSError):
                os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
    try:
        from faster_whisper import WhisperModel
    except ImportError as err:
        eprint(f"faster-whisper is not installed in this python environment: {err}")
        return 1

    if args.self_check:
        eprint(f"self-check OK: faster_whisper imports cleanly (WhisperModel={WhisperModel!r})")
        return 0

    if not args.model or not args.audio_path:
        eprint("--model and an audio_path are both required outside --self-check")
        return 2

    try:
        eprint(f"loading model={args.model} device={args.device} compute={args.compute} threads={args.threads}")
        model = WhisperModel(args.model, device=args.device, compute_type=args.compute, cpu_threads=args.threads)

        eprint(f"transcribing {args.audio_path} language={args.language}")
        segments_iter, info = model.transcribe(
            args.audio_path,
            language=args.language,
            beam_size=1,
            vad_filter=True,
            word_timestamps=True,
        )

        segments = []
        for seg in segments_iter:
            words = None
            if getattr(seg, "words", None):
                words = [
                    {
                        "word": w.word,
                        "start": w.start,
                        "end": w.end,
                        "probability": getattr(w, "probability", None),
                    }
                    for w in seg.words
                ]
            segments.append(
                {
                    "start": seg.start,
                    "end": seg.end,
                    "text": seg.text,
                    "avg_logprob": getattr(seg, "avg_logprob", None),
                    "no_speech_prob": getattr(seg, "no_speech_prob", None),
                    "words": words,
                }
            )

        out = {
            "model": args.model,
            "language": getattr(info, "language", args.language),
            "duration": getattr(info, "duration", None),
            "segments": segments,
        }
        # Exactly one JSON object on stdout, nothing else.
        print(json.dumps(out))
        return 0
    except Exception as err:  # noqa: BLE001 - any failure here must exit non-zero, not crash silently
        eprint(f"local_whisper failed: {err}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
