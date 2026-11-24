# Manual / developer setup on Windows (the normal path is the in-app
# first-run wizard, which does all of this with one click each).
# Run in PowerShell as the user who will run the app.
# All code, comments, log messages and docs in this project are English only.

$ErrorActionPreference = "Stop"

Write-Host "== OpenBuddy manual setup =="

if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
    Write-Host "Ollama not found. Downloading the installer directly from ollama.com…"
    $installer = Join-Path $env:TEMP "OllamaSetup.exe"
    Invoke-WebRequest -Uri "https://ollama.com/download/OllamaSetup.exe" -OutFile $installer
    Start-Process -FilePath $installer -Wait
    Write-Host "Ollama installed. If the installer asked you to restart, do that first."
} else {
    Write-Host "Ollama is already installed."
}

Write-Host "Pulling the default model qwen3:8b (about 8 GB)…"
ollama pull qwen3:8b

Write-Host "Installing app dependencies…"
npm install

Write-Host "Building the app…"
npm run build

Write-Host "Done. Start the app with: npm start"
Write-Host "To build the Windows installer: npm run dist:win:installer"
