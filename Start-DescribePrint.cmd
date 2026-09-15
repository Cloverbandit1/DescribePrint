@echo off
REM Desktop bats (Smith + laptop) call this file. Keep the Start-DescribePrint.cmd entry stable.
setlocal
cd /d "%~dp0"
title DescribePrint

echo DescribePrint — starting from AllosWorkstation
echo.

where powershell >nul 2>nul
if not errorlevel 1 (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\Start-DescribePrint.ps1"
  exit /b %ERRORLEVEL%
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not on PATH.
  echo Install the LTS build from https://nodejs.org and try again.
  pause
  exit /b 1
)

call node "%~dp0scripts\ensure-env-local.mjs" --root "%~dp0."
if errorlevel 1 (
  echo Failed to write .env.local
  pause
  exit /b 1
)

if not exist "vendor\openscad" mkdir "vendor\openscad"

if not exist "node_modules\" (
  echo Installing npm dependencies...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

echo.
echo Launch preflight (Ollama + MODEL + OpenSCAD)...
call npm run --silent health:preflight
if errorlevel 1 (
  echo Preflight reported issues or could not finish. Starting anyway.
)

echo.
echo Local AI default: qwen2.5-coder:32b on 127.0.0.1:11434
echo Do not change the Ollama port. Leave Agent Smith models untouched.
echo OpenSCAD: install from openscad.org or set OPENSCAD_PATH
echo Printer default: Bambu Lab P2S
echo.

start "" cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:3000"
call npm run dev
exit /b %ERRORLEVEL%
