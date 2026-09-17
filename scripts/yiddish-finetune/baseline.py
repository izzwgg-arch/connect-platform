#!/usr/bin/env python3
"""Loopcom Yiddish fine-tune — baseline.py (Lane B, §3.2.3).

The "before" number: WER + CER of the UNTUNED `ivrit-ai/yi-whisper-large-v3-turbo`
on the same `eval.jsonl` (and separately on just the gold rows) that
`train.py` reports its "after" number on. Run this BEFORE the first LoRA run
so there is something to compare against — a fine-tune report with no
baseline is a claim, not a proof.

Runs on the rented pod (same deps as train.py — see requirements.txt).
Writes `baseline_report.json` in the same shape as train.py's `report.json`
so a diff between the two files IS the improvement.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

# Reuse train.py's dependency-free helpers — never re-implement the metric.
from train import assert_no_yl_marker, compute_wer_cer, load_dataset_split


def run_baseline(dataset_dir: Path, model_name: str, batch_size: int) -> dict[str, Any]:
    import torch  # noqa: PLC0415
    import soundfile as sf  # noqa: PLC0415
    from transformers import WhisperForConditionalGeneration, WhisperProcessor  # noqa: PLC0415

    eval_rows = load_dataset_split(dataset_dir, "eval")
    for r in eval_rows:
        assert_no_yl_marker(r["text"])
    gold_rows = [r for r in eval_rows if r.get("gold")]
    print(f"[baseline] {len(eval_rows)} eval rows ({len(gold_rows)} gold), model={model_name}")

    processor = WhisperProcessor.from_pretrained(model_name, language="yi", task="transcribe")
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = WhisperForConditionalGeneration.from_pretrained(model_name).to(device)
    model.generation_config.language = "yi"
    model.generation_config.task = "transcribe"
    model.generation_config.forced_decoder_ids = None
    model.eval()

    def transcribe_all(rows: list[dict[str, Any]]) -> tuple[list[str], list[str]]:
        refs: list[str] = []
        hyps: list[str] = []
        for i in range(0, len(rows), batch_size):
            batch = rows[i : i + batch_size]
            audios = []
            for r in batch:
                audio, sr = sf.read(r["audio_path"], dtype="float32")
                if sr != 16000:
                    raise RuntimeError(f"{r['audio_path']} is {sr}Hz, expected 16000Hz")
                audios.append(audio)
            inputs = processor.feature_extractor(audios, sampling_rate=16000, return_tensors="pt").to(device)
            with torch.no_grad():
                generated = model.generate(inputs.input_features, max_new_tokens=225)
            texts = processor.tokenizer.batch_decode(generated, skip_special_tokens=True)
            refs.extend(r["text"] for r in batch)
            hyps.extend(texts)
        return refs, hyps

    started = time.time()
    refs, hyps = transcribe_all(eval_rows)
    overall = compute_wer_cer(refs, hyps)
    gold_metrics = {"wer": None, "cer": None}
    if gold_rows:
        gold_refs, gold_hyps = transcribe_all(gold_rows)
        gold_metrics = compute_wer_cer(gold_refs, gold_hyps)
    wall_time_sec = time.time() - started

    return {
        "model": model_name,
        "mode": "baseline (untuned)",
        "eval_rows": len(eval_rows),
        "gold_rows": len(gold_rows),
        "wall_time_sec": round(wall_time_sec, 1),
        "eval": overall,
        "gold": gold_metrics,
    }


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Baseline WER/CER for the untuned Yiddish Whisper model")
    p.add_argument("--dataset", required=True, help="directory containing eval.jsonl (from build-dataset.ts)")
    p.add_argument("--model", default="ivrit-ai/yi-whisper-large-v3-turbo")
    p.add_argument("--batch-size", type=int, default=8)
    p.add_argument("--out", default="baseline_report.json")
    return p.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    report = run_baseline(Path(args.dataset), args.model, args.batch_size)
    Path(args.out).write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"[baseline] wrote {args.out}")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
