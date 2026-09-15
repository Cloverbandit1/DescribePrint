@echo off
setlocal
cd /d "%~dp0"
title AllosWorstation Setup

echo AllosWorstation / DescribePrint — first-run setup
echo.

where powershell >nul 2>nul
if not errorlevel 1 (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\Setup-DescribePrint.ps1" %*
  exit /b %ERRORLEVEL%
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not on PATH.
  echo Install the LTS build from https://nodejs.org and try again.
  pause
  exit /b 1
)

echo Running node scripts\install-allos.mjs --layout current
call node "%~dp0scripts\install-allos.mjs" --layout current %*
exit /b %ERRORLEVEL%
