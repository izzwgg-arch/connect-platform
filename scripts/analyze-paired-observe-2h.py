#!/usr/bin/env python3
"""Summarize paired-observe-2h.ndjson → comparison stats for report."""
from __future__ import annotations

import json
import statistics
import sys
from pathlib import Path


def load_samples(path: Path) -> list[dict]:
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            o = json.loads(line)
        except json.JSONDecodeError:
            continue
        if o.get("type") == "sample":
            rows.append(o)
    return rows


def num(x, default=None):
    if x is None:
        return default
    try:
        return int(x)
    except (TypeError, ValueError):
        return default


def series_for_kpi(samples: list[dict], key: str) -> tuple[list[int], list[int]]:
    pbx_vals, c_vals = [], []
    for s in samples:
        pdr = ((s.get("pbx") or {}).get("cdr")) or {}
        br = ((s.get("connect") or {}).get("breakdown")) or {}
        ld = br.get("liveDashboardKpis") or {}
        pv, cv = num(pdr.get(key)), num(ld.get(key))
        if pv is not None and cv is not None:
            pbx_vals.append(pv)
            c_vals.append(cv)
    return pbx_vals, c_vals


def stats_pair(pbx_v: list[int], c_v: list[int]) -> dict | None:
    offs = [c - p for c, p in zip(c_v, pbx_v)]
    if not offs:
        return None
    return {
        "pbx_min": min(pbx_v),
        "pbx_max": max(pbx_v),
        "pbx_last": pbx_v[-1],
        "connect_min": min(c_v),
        "connect_max": max(c_v),
        "connect_last": c_v[-1],
        "offset_avg": round(statistics.mean(offs), 2),
        "offset_max": max(offs),
        "offset_min": min(offs),
        "n": len(offs),
    }


def main() -> None:
    path = Path(sys.argv[1] if len(sys.argv) > 1 else "/opt/connectcomms/logs/paired-observe-2h.ndjson")
    samples = load_samples(path)
    if not samples:
        print("No samples in", path)
        sys.exit(1)

    out: dict = {"sampleCount": len(samples), "kpi": {}}
    for k in ("incomingToday", "outgoingToday", "internalToday", "missedToday"):
        pv, cv = series_for_kpi(samples, k)
        out["kpi"][k] = stats_pair(pv, cv)

    pbx_a, c_a = [], []
    for s in samples:
        p = num((s.get("pbx") or {}).get("ariFinalActiveCalls"))
        summ = (s.get("connect") or {}).get("live") or {}
        c = num(summ.get("totalActiveCalls"))
        if p is not None and c is not None:
            pbx_a.append(p)
            c_a.append(c)
    out["activeCalls"] = stats_pair(pbx_a, c_a)

    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
