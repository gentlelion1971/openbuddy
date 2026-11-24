# Build the voice sidecar into a single frozen executable (run on Windows).
# Output: python/voice-sidecar.exe, which electron-builder bundles into the
# installer (extraResources: python -> python). The app prefers this bundled
# exe; when it is absent, the first-run wizard installs the voice engine
# automatically from embeddable Python instead.
# All code, comments, log messages and docs in this project are English only.

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path | Split-Path -Parent
Set-Location $root

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    Write-Error "Python is required on the build machine. Install Python 3.12 from python.org first."
    exit 1
}

python -m venv .build-venv
.\.build-venv\Scripts\Activate.ps1
pip install --disable-pip-version-check --quiet pyinstaller faster-whisper piper-tts

# Pre-download the Piper voice models so they are bundled too (optional but
# avoids a first-run download).
python -c "import piper; print(piper.__file__)" | Out-Null

pyinstaller --onefile --name voice-sidecar --noconfirm `
    --distpath python `
    --workpath .build-pyinstaller `
    --specpath .build-pyinstaller `
    python/sidecar/voice.py

if (-not (Test-Path python/voice-sidecar.exe)) {
    Write-Error "PyInstaller did not produce python/voice-sidecar.exe"
    exit 1
}

Write-Host "Built: python/voice-sidecar.exe"
Write-Host "Now run: npm run dist:win:installer"
