@echo off
REM AllosWorstation / DescribePrint -- one-click Start
REM Contract: call the repo Start-DescribePrint.cmd (do not start Next.js here).
REM
REM OneDrive syncs Desktop\AllosWorstation\Start DescribePrint.bat between Smith
REM and laptop. This file MUST be identical on both machines. Do not bake a
REM single-machine absolute path -- Install -Layout Smith on a synced Desktop
REM would overwrite the laptop bat (and vice versa).
REM
REM Resolution order for THIS machine:
REM   1) %LOCALAPPDATA%\AllosWorstation\repo-path.txt  (Install writes this; not OneDrive)
REM   2) hostname: %COMPUTERNAME% vs ALLOS_LAPTOP_HOST / ALLOS_SMITH_HOST
REM      or ALLOS_LAYOUT=Laptop|Smith
REM   3) Laptop repo: %USERPROFILE%\AllosWorstation\DescribePrint
REM      (absolute cd /d -- not %~dp0DescribePrint)
REM   4) Smith repo:  %~dp0DescribePrint  (sibling of this bat)
setlocal EnableExtensions
set "CMDNAME=Start-DescribePrint.cmd"
set "LAPTOP=%USERPROFILE%\AllosWorstation\DescribePrint"
set "SMITH=%~dp0DescribePrint"
set "HINT=%LOCALAPPDATA%\AllosWorstation\repo-path.txt"
set "TARGET="

if exist "%HINT%" set /p TARGET=<"%HINT%"
if defined TARGET goto run

if /i "%ALLOS_LAYOUT%"=="Laptop" goto laptop
if /i "%ALLOS_LAYOUT%"=="Smith" goto smith
if defined ALLOS_LAPTOP_HOST if /i "%COMPUTERNAME%"=="%ALLOS_LAPTOP_HOST%" goto laptop
if defined ALLOS_SMITH_HOST if /i "%COMPUTERNAME%"=="%ALLOS_SMITH_HOST%" goto smith

if exist "%LAPTOP%\%CMDNAME%" goto laptop
if exist "%SMITH%\%CMDNAME%" goto smith

echo DescribePrint Start.cmd not found for this machine.
echo   Laptop: %LAPTOP%
echo   Smith:  %SMITH%
echo   Hint:   %HINT%
echo Run Install-AllosWorstation.ps1 -Layout Laptop  or  -Layout Smith
pause
exit /b 1

:laptop
set "TARGET=%LAPTOP%"
goto run

:smith
set "TARGET=%SMITH%"
goto run

:run
if not exist "%TARGET%\%CMDNAME%" (
  echo Missing "%TARGET%\%CMDNAME%"
  echo Hint file: %HINT%
  pause
  exit /b 1
)
cd /d "%TARGET%"
call "%TARGET%\%CMDNAME%"
exit /b %ERRORLEVEL%
