#!/usr/bin/env python3
"""Count mid-speech dropouts in Asterisk MixMonitor recordings (8 kHz, 16-bit, mono WAV).

A "hole" is 15-400 ms of near-digital silence (10 ms RMS < 3) with speech (RMS > 300)
within 150 ms on both sides. Holes per minute of speech is the comparable number.
Reference (2026-09-17 handoff AGENT_HANDOFF_PLATFORM_AUDIO_BREAKUP_2026-09-17.md):
healthy July/August recordings = 0-1.4 holes/min; lossy Sep 16-17 recordings = 2.4-7.8.

Usage: python recording-gap-census.py <directory-with-wav-files>
Read-only; copy the recordings off the PBX with scp first, never run it on the PBX.
"""
import array
import glob
import os
import sys
import wave


def analyze(path):
    w = wave.open(path, "rb")
    n, sr, ch = w.getnframes(), w.getframerate(), w.getnchannels()
    data = w.readframes(n)
    w.close()
    a = array.array("h")
    a.frombytes(data)
    if ch == 2:
        a = a[0::2]
    frame = int(sr * 0.01)  # 10 ms
    nf = len(a) // frame
    rms = []
    for i in range(nf):
        seg = a[i * frame:(i + 1) * frame]
        s = 0
        for v in seg:
            s += v * v
        rms.append((s / frame) ** 0.5)
    speech = [r > 300 for r in rms]
    hole = [r < 3 for r in rms]
    holes = []
    i = 0
    while i < nf:
        if hole[i]:
            j = i
            while j < nf and hole[j]:
                j += 1
            length_ms = (j - i) * 10
            pre = any(speech[max(0, i - 15):i])
            post = any(speech[j:j + 15])
            if 15 <= length_ms <= 400 and pre and post:
                holes.append((i * 10, length_ms))
            i = j
        else:
            i += 1
    return len(a) / sr, sum(speech) / 100.0, holes


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    for p in sorted(glob.glob(os.path.join(sys.argv[1], "*.wav"))):
        dur, speech_s, holes = analyze(p)
        per_min = len(holes) / max(speech_s / 60, 0.01)
        print(
            f"{os.path.basename(p)[:75]:75s} dur={dur:6.0f}s speech={speech_s:5.0f}s "
            f"holes={len(holes):3d} holes/min-speech={per_min:5.1f} "
            f"lens(ms)={[h[1] for h in holes][:12]}"
        )


if __name__ == "__main__":
    main()
