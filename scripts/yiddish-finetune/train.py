#!/usr/bin/env python3
"""Loopcom Yiddish fine-tune — train.py (Lane B, §3.2.2).

Runs ON THE RENTED POD (runpod-pod.ts uploads this file + requirements.txt
and runs it under nohup). NOT meant to run on Izzy's PC, which has no GPU —
see `--self-test` below for what CAN run there.

Fine-tunes `ivrit-ai/yi-whisper-large-v3-turbo` (default LoRA via `peft`,
`--full` for full fine-tune) on the dataset `build-dataset.ts` produced
(`train.jsonl` / `eval.jsonl`, HF audiofolder shape), with
language="yi", task="transcribe". Reports WER + CER on the whole eval set
AND separately on just the gold (`"gold": true`) rows — the gold-only number
is the one that actually proves the fine-tune helped, since gold text is
human-corrected ground truth rather than another machine's guess.

After training: merges the LoRA adapter into the base weights (a full-FT run
has nothing to merge), converts to CTranslate2 (`out-ct2/`, float16) with
`ct2-transformers-converter` so the platform's existing faster-whisper
serverless worker can serve it unchanged, and writes `report.json`.

⛔ Never reads a Yiddish Labs transcript as a label. Every text field in the
dataset file came from `YcTranscript.engine in ("ivrit", "human")` — nothing
in this file re-derives text from anywhere else.

Self-test (`--self-test`): builds a 3-row fake dataset and exercises the
data-collator + metric code with NO model download. This machine (Izzy's PC)
has Python 3.14 and no `torch`, so the self-test runs in TIERS and reports
exactly which ran:
  Tier 0 (stdlib + numpy only): jsonl round-trip, text normalisation, and a
          pure-Python Levenshtein WER/CER used ONLY as a self-test fallback
          when `jiwer` is not installed — real training always uses `jiwer`.
  Tier 1 (needs `jiwer`): the same metric computed with the real library, to
          prove our wiring calls it correctly.
  Tier 2 (needs `torch`+`transformers`): a tiny, randomly-initialised
          `WhisperConfig`/`WhisperForConditionalGeneration` (no hub download)
          exercises `DataCollatorSpeechSeq2SeqWithPadding`'s padding math on
          fake feature/label tensors. A real `WhisperProcessor` needs a hub
          download for its tokenizer vocab, so tier 2 uses STUBBED features
          and label ID lists instead of a real processor — this is exactly
          the "stubbed features" degrade the build spec calls for.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

YL_MARKERS = ("yiddishlabs", "yiddish-labs", "yiddish_labs", "yiddish labs")


def assert_no_yl_marker(text: str) -> None:
    low = text.lower()
    for m in YL_MARKERS:
        if m in low:
            raise RuntimeError(f"Yiddish Labs marker found in a supposedly-clean field: {m!r}")


# ── pure, dependency-free helpers (Tier 0) ──────────────────────────────────


def load_jsonl(path: str | Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
    return rows


def normalize_text(text: str) -> str:
    """Whitespace-only normalisation for WER/CER comparison — never touches
    spelling, so it cannot hide a real transcription difference."""
    return " ".join(text.strip().split())


def _levenshtein(a: list[str], b: list[str]) -> int:
    if a == b:
        return 0
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        cur = [i] + [0] * len(b)
        for j, cb in enumerate(b, start=1):
            cost = 0 if ca == cb else 1
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
        prev = cur
    return prev[-1]


def simple_wer(reference: str, hypothesis: str) -> float:
    """Pure-Python word error rate. ⛔ SELF-TEST FALLBACK ONLY — real training
    always uses `jiwer` (see `compute_wer_cer`); this exists so the self-test
    still proves the metric WIRING is correct on a box with no pip deps."""
    ref_words = normalize_text(reference).split()
    hyp_words = normalize_text(hypothesis).split()
    if not ref_words:
        return 0.0 if not hyp_words else 1.0
    return _levenshtein(ref_words, hyp_words) / len(ref_words)


def simple_cer(reference: str, hypothesis: str) -> float:
    """Pure-Python character error rate. Same fallback-only caveat as `simple_wer`."""
    ref_chars = list(normalize_text(reference).replace(" ", ""))
    hyp_chars = list(normalize_text(hypothesis).replace(" ", ""))
    if not ref_chars:
        return 0.0 if not hyp_chars else 1.0
    return _levenshtein(ref_chars, hyp_chars) / len(ref_chars)


def compute_wer_cer(references: list[str], hypotheses: list[str]) -> dict[str, float]:
    """The metric used for every REAL report. Requires `jiwer` — raises
    rather than silently degrading to the self-test fallback, because a
    report.json with a fallback metric would be a false record."""
    import jiwer  # noqa: PLC0415 (deliberately lazy — self-test tier 0 must not need this)

    refs = [normalize_text(r) for r in references]
    hyps = [normalize_text(h) for h in hypotheses]
    return {"wer": float(jiwer.wer(refs, hyps)), "cer": float(jiwer.cer(refs, hyps))}


# ── dataset loading (needs datasets/soundfile — real training only) ────────


def find_latest_checkpoint(output_dir: Path) -> Path | None:
    """The highest-step `checkpoint-<N>` directory directly under `output_dir`,
    or None if there isn't one. Pure filesystem scan — no torch/transformers
    needed, so this runs (and is tested) on Izzy's PC too.

    This is what makes a 12-hour Kaggle session cap survivable across
    multiple sessions: `run_training` calls this BEFORE `trainer.train()` and
    passes the result as `resume_from_checkpoint`, so a session that hits the
    wall mid-run leaves a checkpoint the NEXT session picks up automatically
    (same `--output-dir`, same dataset) instead of starting over from step 0.
    """
    if not output_dir.exists():
        return None
    best: tuple[int, Path] | None = None
    for p in output_dir.iterdir():
        if not p.is_dir() or not p.name.startswith("checkpoint-"):
            continue
        suffix = p.name[len("checkpoint-") :]
        if not suffix.isdigit():
            continue
        step = int(suffix)
        if best is None or step > best[0]:
            best = (step, p)
    return best[1] if best else None


def load_dataset_split(dataset_dir: Path, split: str) -> list[dict[str, Any]]:
    rows = load_jsonl(dataset_dir / f"{split}.jsonl")
    for r in rows:
        assert_no_yl_marker(r.get("text", ""))
        r["audio_path"] = str((dataset_dir / r["audio"]).resolve())
    return rows


# ── heavy path (real training) ──────────────────────────────────────────────


def build_model_and_processor(model_name: str, use_lora: bool, lora_r: int, lora_alpha: int):
    import torch  # noqa: PLC0415
    from transformers import WhisperForConditionalGeneration, WhisperProcessor  # noqa: PLC0415

    processor = WhisperProcessor.from_pretrained(model_name, language="yi", task="transcribe")
    model = WhisperForConditionalGeneration.from_pretrained(
        model_name, torch_dtype=torch.float16 if torch.cuda.is_available() else torch.float32
    )
    model.generation_config.language = "yi"
    model.generation_config.task = "transcribe"
    model.generation_config.forced_decoder_ids = None

    if use_lora:
        from peft import LoraConfig, get_peft_model  # noqa: PLC0415

        lora_cfg = LoraConfig(
            r=lora_r,
            lora_alpha=lora_alpha,
            target_modules=["q_proj", "v_proj"],
            lora_dropout=0.05,
            bias="none",
        )
        model = get_peft_model(model, lora_cfg)
        model.print_trainable_parameters()
    return model, processor


@dataclass
class DataCollatorSpeechSeq2SeqWithPadding:
    """Standard Whisper fine-tune collator: pads log-mel features (already a
    fixed length from the feature extractor, so this is really a stack) and
    pads label token ids with -100 so the loss ignores padding."""

    processor: Any
    decoder_start_token_id: int

    def __call__(self, features: list[dict[str, Any]]) -> dict[str, Any]:
        import torch  # noqa: PLC0415

        input_features = [{"input_features": f["input_features"]} for f in features]
        batch = self.processor.feature_extractor.pad(input_features, return_tensors="pt")

        label_features = [{"input_ids": f["labels"]} for f in features]
        labels_batch = self.processor.tokenizer.pad(label_features, return_tensors="pt")
        labels = labels_batch["input_ids"].masked_fill(labels_batch.attention_mask.ne(1), -100)
        if (labels[:, 0] == self.decoder_start_token_id).all().item():
            labels = labels[:, 1:]
        batch["labels"] = labels
        return batch


def build_compute_metrics(processor):
    def compute_metrics(pred) -> dict[str, float]:
        import numpy as np  # noqa: PLC0415

        pred_ids = pred.predictions
        label_ids = pred.label_ids
        label_ids = np.where(label_ids != -100, label_ids, processor.tokenizer.pad_token_id)
        pred_str = processor.tokenizer.batch_decode(pred_ids, skip_special_tokens=True)
        label_str = processor.tokenizer.batch_decode(label_ids, skip_special_tokens=True)
        return compute_wer_cer(label_str, pred_str)

    return compute_metrics


def run_training(args: argparse.Namespace) -> dict[str, Any]:
    import numpy as np  # noqa: PLC0415
    import soundfile as sf  # noqa: PLC0415
    import torch  # noqa: PLC0415
    from datasets import Dataset  # noqa: PLC0415
    from transformers import Seq2SeqTrainer, Seq2SeqTrainingArguments  # noqa: PLC0415

    dataset_dir = Path(args.dataset)
    train_rows = load_dataset_split(dataset_dir, "train")
    eval_rows = load_dataset_split(dataset_dir, "eval")
    gold_rows = [r for r in eval_rows if r.get("gold")]
    print(f"[train] {len(train_rows)} train rows, {len(eval_rows)} eval rows ({len(gold_rows)} gold)")

    model, processor = build_model_and_processor(args.model, not args.full, args.lora_r, args.lora_alpha)

    def to_features(row: dict[str, Any]) -> dict[str, Any]:
        audio, sr = sf.read(row["audio_path"], dtype="float32")
        if sr != 16000:
            raise RuntimeError(f"{row['audio_path']} is {sr}Hz, expected 16000Hz (build-dataset.ts cuts at 16kHz)")
        input_features = processor.feature_extractor(audio, sampling_rate=16000).input_features[0]
        labels = processor.tokenizer(row["text"]).input_ids
        return {"input_features": input_features, "labels": labels}

    train_ds = Dataset.from_list(train_rows).map(to_features, remove_columns=list(train_rows[0].keys()) if train_rows else [])
    eval_ds = Dataset.from_list(eval_rows).map(to_features, remove_columns=list(eval_rows[0].keys()) if eval_rows else [])

    collator = DataCollatorSpeechSeq2SeqWithPadding(processor=processor, decoder_start_token_id=model.config.decoder_start_token_id)

    # T4/P100 (the free-tier and cheap-consumer-card reality this defaults for)
    # have NO bf16 tensor cores — bf16=True there either errors or silently
    # falls back, so we probe support at runtime and only ever set ONE of
    # fp16/bf16, never both.
    use_bf16 = bool(torch.cuda.is_available() and torch.cuda.is_bf16_supported())
    training_args = Seq2SeqTrainingArguments(
        output_dir=args.output_dir,
        per_device_train_batch_size=args.batch_size,
        per_device_eval_batch_size=max(1, args.batch_size // 2),
        gradient_accumulation_steps=args.grad_accum,
        gradient_checkpointing=True,
        learning_rate=args.lr,
        max_steps=args.max_steps,
        fp16=not use_bf16,
        bf16=use_bf16,
        eval_strategy="steps",
        eval_steps=args.eval_steps,
        predict_with_generate=True,
        generation_max_length=225,
        # ⛔ 2026-09-18: was "no" — a Kaggle session that hit the 12h wall left
        # NOTHING usable. Periodic checkpoints + save_total_limit (bounded disk
        # use on a 20GB-ish /kaggle/working) + find_latest_checkpoint's resume
        # below are what let a run span more than one 12h Kaggle session.
        save_strategy="steps",
        save_steps=args.save_steps,
        save_total_limit=2,
        logging_steps=10,
        report_to=[],
    )

    trainer = Seq2SeqTrainer(
        args=training_args,
        model=model,
        train_dataset=train_ds,
        eval_dataset=eval_ds,
        data_collator=collator,
        compute_metrics=build_compute_metrics(processor),
        tokenizer=processor.feature_extractor,
    )

    resume_ckpt = find_latest_checkpoint(Path(args.output_dir))
    if resume_ckpt:
        print(f"[train] resuming from checkpoint {resume_ckpt}")
    started = time.time()
    trainer.train(resume_from_checkpoint=str(resume_ckpt) if resume_ckpt else None)
    wall_time_sec = time.time() - started

    eval_metrics = trainer.evaluate(eval_dataset=eval_ds)
    gold_metrics = {"eval_wer": None, "eval_cer": None}
    if gold_rows:
        gold_ds = Dataset.from_list(gold_rows).map(to_features, remove_columns=list(gold_rows[0].keys()))
        gold_metrics = trainer.evaluate(eval_dataset=gold_ds, metric_key_prefix="gold")

    merged_dir = Path(args.output_dir) / "merged"
    merged_dir.mkdir(parents=True, exist_ok=True)
    if not args.full:
        merged_model = model.merge_and_unload()
    else:
        merged_model = model
    merged_model.save_pretrained(merged_dir)
    processor.save_pretrained(merged_dir)

    ct2_dir = Path("out-ct2")
    convert_result = subprocess.run(
        ["ct2-transformers-converter", "--model", str(merged_dir), "--output_dir", str(ct2_dir), "--quantization", "float16", "--force"],
        capture_output=True,
        text=True,
    )
    if convert_result.returncode != 0:
        print("[train] ct2-transformers-converter FAILED:", convert_result.stderr[-2000:], file=sys.stderr)

    if args.push_to_hub:
        hf_token = os.environ.get("HF_TOKEN")
        if not hf_token:
            print("[train] --push-to-hub requested but HF_TOKEN is not set — skipping push", file=sys.stderr)
        else:
            merged_model.push_to_hub(args.push_to_hub, token=hf_token)
            processor.push_to_hub(args.push_to_hub, token=hf_token)

    report = {
        "model": args.model,
        "mode": "full" if args.full else f"lora(r={args.lora_r},alpha={args.lora_alpha})",
        "train_rows": len(train_rows),
        "eval_rows": len(eval_rows),
        "gold_rows": len(gold_rows),
        "max_steps": args.max_steps,
        "batch_size": args.batch_size,
        "grad_accum": args.grad_accum,
        "precision": "bf16" if use_bf16 else "fp16",
        "resumed_from": str(resume_ckpt) if resume_ckpt else None,
        "wall_time_sec": round(wall_time_sec, 1),
        "eval": {"wer": eval_metrics.get("eval_wer"), "cer": eval_metrics.get("eval_cer")},
        "gold": {"wer": gold_metrics.get("gold_wer"), "cer": gold_metrics.get("gold_cer")},
        "ct2_ok": convert_result.returncode == 0,
        "pushed_to_hub": bool(args.push_to_hub) and bool(os.environ.get("HF_TOKEN")),
        "hourly_price_usd": float(os.environ["RUNPOD_HOURLY_PRICE"]) if os.environ.get("RUNPOD_HOURLY_PRICE") else None,
    }
    if report["hourly_price_usd"] is not None:
        report["estimated_cost_usd"] = round(report["hourly_price_usd"] * wall_time_sec / 3600, 2)
    return report


# ── self-test ────────────────────────────────────────────────────────────────


def fake_dataset_rows() -> list[dict[str, Any]]:
    return [
        {"audio": "clips/a.wav", "text": "a sholem aleichem tzu aych", "source": "yiddish24", "item": "item-1", "confidence": 0.9, "gold": False},
        {"audio": "clips/b.wav", "text": "vi geyt es aych haynt", "source": "voicemail", "item": "item-2", "confidence": 1.0, "gold": True},
        {"audio": "clips/c.wav", "text": "a dank aych zeyer", "source": "yiddish24", "item": "item-3", "confidence": 0.7, "gold": False},
    ]


def self_test() -> int:
    ran: list[str] = []
    skipped: list[str] = []
    failed: list[str] = []

    # Tier 0 — stdlib + numpy only.
    try:
        rows = fake_dataset_rows()
        tmp = Path(os.environ.get("TMPDIR", ".")) / f"yc_train_selftest_{os.getpid()}.jsonl"
        with open(tmp, "w", encoding="utf-8") as fh:
            for r in rows:
                fh.write(json.dumps(r) + "\n")
        loaded = load_jsonl(tmp)
        tmp.unlink(missing_ok=True)
        assert loaded == rows, "jsonl round-trip changed the data"
        assert normalize_text("  hello   world  ") == "hello world"
        for r in rows:
            assert_no_yl_marker(r["text"])
        wer = simple_wer("a b c d", "a b x d")
        cer = simple_cer("abcd", "abcx")
        assert 0 < wer < 1, f"unexpected wer {wer}"
        assert 0 < cer < 1, f"unexpected cer {cer}"
        assert simple_wer("same text", "same text") == 0.0

        # find_latest_checkpoint: pure filesystem scan, no GPU/torch needed —
        # exercises the resume-from-checkpoint wiring's core logic.
        import shutil
        import tempfile

        ckpt_root = Path(tempfile.mkdtemp(prefix="yc_train_selftest_ckpt_"))
        try:
            assert find_latest_checkpoint(ckpt_root) is None, "empty dir must resume from nothing"
            (ckpt_root / "checkpoint-100").mkdir()
            (ckpt_root / "checkpoint-250").mkdir()
            (ckpt_root / "checkpoint-50").mkdir()
            (ckpt_root / "not-a-checkpoint").mkdir()
            (ckpt_root / "checkpoint-abc").mkdir()  # non-numeric suffix, must be ignored
            latest = find_latest_checkpoint(ckpt_root)
            assert latest is not None and latest.name == "checkpoint-250", f"expected checkpoint-250, got {latest}"
            assert find_latest_checkpoint(ckpt_root / "does-not-exist") is None, "a missing output dir must resume from nothing"
        finally:
            shutil.rmtree(ckpt_root, ignore_errors=True)

        ran.append("tier0: jsonl load/round-trip, normalize_text, YL-marker guard, pure-Python WER/CER fallback, find_latest_checkpoint")
    except Exception as exc:  # noqa: BLE001
        failed.append(f"tier0: {exc}")

    # Tier 1 — needs jiwer.
    try:
        import jiwer  # noqa: F401,PLC0415

        metrics = compute_wer_cer(["a b c d"], ["a b x d"])
        assert 0 < metrics["wer"] < 1
        ran.append("tier1: compute_wer_cer via the real jiwer library")
    except ImportError:
        skipped.append("tier1 (needs jiwer, not installed on this host)")
    except Exception as exc:  # noqa: BLE001
        failed.append(f"tier1: {exc}")

    # Tier 2 — needs torch + transformers (NO hub download: a randomly
    # initialised tiny WhisperConfig, and STUBBED features/labels rather than
    # a real processor, per the build spec's explicit degrade instruction).
    try:
        import torch  # noqa: PLC0415
        from transformers import WhisperConfig, WhisperForConditionalGeneration  # noqa: PLC0415

        tiny_config = WhisperConfig(
            vocab_size=51865,
            d_model=32,
            encoder_layers=1,
            decoder_layers=1,
            encoder_attention_heads=2,
            decoder_attention_heads=2,
            encoder_ffn_dim=64,
            decoder_ffn_dim=64,
            max_source_positions=64,
            max_target_positions=64,
            num_mel_bins=80,
        )
        model = WhisperForConditionalGeneration(tiny_config)

        class StubFeatureExtractor:
            def pad(self, features, return_tensors="pt"):
                arr = torch.stack([torch.tensor(f["input_features"], dtype=torch.float32) for f in features])
                return {"input_features": arr}

        class StubTokenizer:
            pad_token_id = 0

            def pad(self, features, return_tensors="pt"):
                max_len = max(len(f["input_ids"]) for f in features)
                ids = torch.full((len(features), max_len), self.pad_token_id, dtype=torch.long)
                mask = torch.zeros((len(features), max_len), dtype=torch.long)
                for i, f in enumerate(features):
                    n = len(f["input_ids"])
                    ids[i, :n] = torch.tensor(f["input_ids"], dtype=torch.long)
                    mask[i, :n] = 1

                class R:
                    pass

                r = R()
                r.__setattr__("input_ids", ids)
                r.__setattr__("attention_mask", mask)
                return r

        class StubProcessor:
            feature_extractor = StubFeatureExtractor()
            tokenizer = StubTokenizer()

        collator = DataCollatorSpeechSeq2SeqWithPadding(processor=StubProcessor(), decoder_start_token_id=model.config.decoder_start_token_id)
        fake_features = [
            {"input_features": [[0.0] * 64] * 80, "labels": [1, 2, 3]},
            {"input_features": [[0.0] * 64] * 80, "labels": [1, 2, 3, 4, 5]},
        ]
        batch = collator(fake_features)
        assert batch["labels"].shape[0] == 2
        assert batch["input_features"].shape[0] == 2
        ran.append("tier2: DataCollatorSpeechSeq2SeqWithPadding padding math, tiny randomly-initialised WhisperConfig, no hub download, STUBBED processor")
    except ImportError:
        skipped.append("tier2 (needs torch+transformers, not installed on this host)")
    except Exception as exc:  # noqa: BLE001
        failed.append(f"tier2: {exc}")

    print("[train --self-test] RAN:")
    for r in ran:
        print(f"  - {r}")
    print("[train --self-test] SKIPPED:")
    for s in skipped:
        print(f"  - {s}")
    if failed:
        print("[train --self-test] FAILED:")
        for f in failed:
            print(f"  - {f}")
        return 1
    print("[train --self-test] all runnable tiers passed.")
    return 0


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Loopcom Yiddish Whisper fine-tune")
    p.add_argument("--dataset", help="directory containing train.jsonl/eval.jsonl (from build-dataset.ts)")
    p.add_argument("--model", default="ivrit-ai/yi-whisper-large-v3-turbo")
    p.add_argument("--full", action="store_true", help="full fine-tune instead of the default LoRA")
    p.add_argument("--lora-r", type=int, default=32)
    p.add_argument("--lora-alpha", type=int, default=64)
    # Defaults sized for a 16 GB card (T4/P100 — the free Kaggle tier and the
    # cheap consumer cards runpod-pod.ts now prefers), not the 80GB A100 the
    # original defaults assumed. LoRA on whisper-large-v3-turbo fits ~10-12GB
    # at batch 4 / grad-accum 8; raise --batch-size on a bigger card.
    p.add_argument("--max-steps", type=int, default=2000)
    p.add_argument("--batch-size", type=int, default=4)
    p.add_argument("--grad-accum", type=int, default=8)
    p.add_argument("--eval-steps", type=int, default=250)
    p.add_argument("--save-steps", type=int, default=250, help="checkpoint interval — also the interval a chained 12h Kaggle session can resume from")
    p.add_argument("--lr", type=float, default=1e-5)
    p.add_argument("--output-dir", default="out")
    p.add_argument("--push-to-hub", default=None, help="HF repo id to push the merged model to (needs HF_TOKEN)")
    p.add_argument("--self-test", action="store_true")
    return p.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    if args.self_test:
        return self_test()
    if not args.dataset:
        print("error: --dataset is required (or pass --self-test)", file=sys.stderr)
        return 2
    report = run_training(args)
    # Written to the CWD (the pod runs this from .../yiddish-finetune/), which
    # is exactly where runpod-pod.ts's isTrainingDone()/download() look for it.
    out_path = Path("report.json")
    out_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"[train] wrote {out_path}")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
