# Bootstrap a Windows machine with an NVIDIA GPU as the Yiddish audio runner
# (2026-09-17, Izzy's Dell Precision 3630 "D19M"). Run in an ELEVATED PowerShell:
#
#   Set-ExecutionPolicy -Scope Process Bypass; .\bootstrap-dell.ps1
#
# What it does (idempotent — safe to run twice):
#   1. winget-installs Node.js LTS, Python 3.12 (3.14 has no GPU wheels yet), FFmpeg.
#   2. Creates the runner folder at the SAME path the database already references
#      (C:\Users\<you>\LoopcomYiddishRunner\audio\...) and a Python venv with
#      faster-whisper + the CUDA 12 / cuDNN 9 runtime wheels (no CUDA toolkit install needed).
#   3. Prints the GPU, checks CTranslate2 can see CUDA, and runs a 30-second speed test
#      on a bundled silence file so you get a realtime factor BEFORE any real audio.
#   4. Writes .env.example lines you complete (DATABASE_URL via the tunnel, YC_* backend vars).
# It never copies audio or keys: those move separately (see README "Moving the runner").
param(
  [string]$Runner = "$env:USERPROFILE\LoopcomYiddishRunner",
  [string]$Model = "ivrit-ai/yi-whisper-large-v3-turbo-ct2"
)
$ErrorActionPreference = "Stop"
function Say($m) { Write-Host "[bootstrap] $m" }

Say "1/5 packages (winget)"
$pkgs = @(
  @{ id = "OpenJS.NodeJS.LTS";  test = { Get-Command node -ErrorAction SilentlyContinue } },
  @{ id = "Python.Python.3.12"; test = { Get-Command py -ErrorAction SilentlyContinue } },
  @{ id = "Gyan.FFmpeg";        test = { Get-Command ffmpeg -ErrorAction SilentlyContinue } }
)
foreach ($p in $pkgs) {
  if (& $p.test) { Say "  $($p.id) already present" }
  else { winget install --id $p.id -e --accept-source-agreements --accept-package-agreements --silent | Out-Null; Say "  installed $($p.id)" }
}
# refresh PATH for this session
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

Say "2/5 runner folder + Python venv at $Runner"
New-Item -ItemType Directory -Force "$Runner\audio", "$Runner\logs", "$Runner\code" | Out-Null
if (-not (Test-Path "$Runner\.venv\Scripts\python.exe")) { & py -3.12 -m venv "$Runner\.venv" }
$py = "$Runner\.venv\Scripts\python.exe"
& $py -m pip install --quiet --upgrade pip
# faster-whisper (CTranslate2) + the NVIDIA runtime libraries it dlopens on Windows.
& $py -m pip install --quiet faster-whisper "nvidia-cublas-cu12" "nvidia-cudnn-cu12==9.*"
Say "  faster-whisper installed"

Say "3/5 GPU check"
$gpu = Get-CimInstance Win32_VideoController | Where-Object { $_.Name -match "NVIDIA" } | Select-Object -First 1
if ($gpu) { Say "  GPU: $($gpu.Name) ($([math]::Round($gpu.AdapterRAM/1GB,1)) GB reported by Windows; nvidia-smi is authoritative)" } else { Say "  ⚠ no NVIDIA GPU found — labelling would fall back to CPU" }
if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) { nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader | ForEach-Object { Say "  nvidia-smi: $_" } }
# Put the pip-installed CUDA/cuDNN DLL folders on PATH so CTranslate2 finds them.
$site = & $py -c "import sysconfig; print(sysconfig.get_paths()['purelib'])"
$cudaBins = @("$site\nvidia\cublas\bin", "$site\nvidia\cudnn\bin") | Where-Object { Test-Path $_ }
$env:Path = ($cudaBins -join ";") + ";" + $env:Path
$cuda = & $py -c "import ctranslate2; print(ctranslate2.get_cuda_device_count())"
Say "  CTranslate2 CUDA devices: $cuda"

Say "4/5 speed test (downloads the ~1.6 GB model on first run)"
$bench = @"
import time, sys, wave, struct, os
from faster_whisper import WhisperModel
dev = 'cuda' if int(sys.argv[2]) > 0 else 'cpu'
ct = 'float16' if dev == 'cuda' else 'int8'
p = os.path.join(sys.argv[3], 'logs', 'bench-30s.wav')
if not os.path.exists(p):
    with wave.open(p, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
        import random; random.seed(1)
        w.writeframes(b''.join(struct.pack('<h', random.randint(-300, 300)) for _ in range(16000*30)))
t0 = time.time(); m = WhisperModel(sys.argv[1], device=dev, compute_type=ct); t1 = time.time()
segs, info = m.transcribe(p, language='yi', beam_size=1, vad_filter=False); list(segs); t2 = time.time()
print(f'device={dev} compute={ct} load={t1-t0:.1f}s transcribe={t2-t1:.1f}s for 30.0s → realtime x{30/(t2-t1):.1f}')
"@
Set-Content -Path "$Runner\logs\bench.py" -Value $bench -Encoding UTF8
& $py "$Runner\logs\bench.py" $Model $cuda $Runner

Say "5/5 env template"
$envExample = @"
# Complete and save as .env in $Runner (never commit it).
DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:15432/connectcomms
YC_TRANSCRIBE_BACKEND=local
YC_LOCAL_WHISPER_PYTHON=$py
YC_LOCAL_WHISPER_MODEL=$Model
YC_LOCAL_WHISPER_DEVICE=cuda
YC_LOCAL_WHISPER_COMPUTE=float16
YC_LOCAL_WHISPER_THREADS=8
# CUDA/cuDNN DLL folders from pip — local_whisper.py adds them with os.add_dll_directory:
YC_CUDA_BIN=$($cudaBins -join ';')
"@
Set-Content -Path "$Runner\.env.example" -Value $envExample -Encoding UTF8
Say "done. Next: copy the runner folder + audio from the old PC (README: Moving the runner), fill .env, run start.cmd."
