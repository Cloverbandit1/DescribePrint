# DescribePrint - AllosWorkstation Windows start
# One-click: deps, .env.local, health preflight (warn+continue), then Next.js on http://localhost:3000
# Entry for Desktop bats remains Start-DescribePrint.cmd (this file is the PowerShell path).
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $Root
$Host.UI.RawUI.WindowTitle = 'DescribePrint'

function Test-Command($Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

Write-Host 'DescribePrint - starting from AllosWorkstation' -ForegroundColor Green
Write-Host ''

if (-not (Test-Command 'node')) {
    Write-Host 'Node.js is not on PATH.' -ForegroundColor Red
    Write-Host 'Install the LTS build from https://nodejs.org and try again.'
    if ($Host.Name -eq 'ConsoleHost') { Read-Host 'Press Enter to close' | Out-Null }
    exit 1
}

if (-not (Test-Command 'npm')) {
    Write-Host 'npm is not on PATH. Reinstall Node.js LTS so npm is included.' -ForegroundColor Red
    if ($Host.Name -eq 'ConsoleHost') { Read-Host 'Press Enter to close' | Out-Null }
    exit 1
}

& node (Join-Path $Root 'scripts\ensure-env-local.mjs') --root $Root
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$vendor = Join-Path $Root 'vendor\openscad'
if (-not (Test-Path $vendor)) {
    New-Item -ItemType Directory -Path $vendor | Out-Null
}

if (-not (Test-Path (Join-Path $Root 'node_modules'))) {
    Write-Host 'Installing npm dependencies...'
    npm install
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host ''
Write-Host 'Launch preflight (Ollama + MODEL + OpenSCAD)...' -ForegroundColor Cyan
npm run --silent health:preflight
$preflight = $LASTEXITCODE
if ($preflight -eq 1) {
    Write-Host 'Preflight could not finish. Starting the app anyway.' -ForegroundColor Yellow
} elseif ($preflight -eq 2) {
    Write-Host 'Preflight reported issues. Starting anyway - generate/compile may fail until those are fixed.' -ForegroundColor Yellow
} elseif ($preflight -ne 0 -and $preflight -ne $null) {
    Write-Host "Preflight exited $preflight. Starting the app anyway." -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'Local AI default: qwen2.5-coder:32b on 127.0.0.1:11434'
Write-Host 'Do not change the Ollama port. Leave Agent Smith models untouched.'
Write-Host 'OpenSCAD: install from openscad.org, set OPENSCAD_PATH, or drop openscad.exe in vendor\openscad\'
Write-Host 'Printer default: Bambu Lab P2S'
Write-Host ''

$openBrowser = {
    Start-Sleep -Seconds 3
    Start-Process 'http://localhost:3000'
}
Start-Job -ScriptBlock $openBrowser | Out-Null

Write-Host 'Opening http://localhost:3000 - describe a part, then Print.'
npm run dev
exit $LASTEXITCODE
