# Keep the Smith desktop awake for LAN / Tailscale hosting.
# Sets the CURRENT power scheme: plugged in (AC) sleep + hibernate timeout = never.
# Does NOT change battery (DC) timeouts. Does NOT run on Laptop unless -ForceHost.
# Hibernate-off is machine-wide and may need elevation; failure is a warning only.
[CmdletBinding()]
param(
    [ValidateSet('Smith', 'Laptop', 'Current')]
    [string]$Layout = 'Current',
    [switch]$ForceHost,
    [switch]$DryRun
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Write-PowerQuery {
    Write-Host ''
    Write-Host 'Current scheme (SUB_SLEEP) after change:'
    try {
        $query = powercfg.exe /QUERY SCHEME_CURRENT SUB_SLEEP
        foreach ($line in $query) {
            if ($line -match 'STANDBYIDLE|HIBERNATEIDLE|RTCWAKE|Current (AC|DC) Power Setting Index') {
                Write-Host ('  ' + $line.Trim())
            }
        }
    } catch {
        Write-Host '  (could not query powercfg; settings were still applied)'
    }
}

Write-Host 'AllosWorstation - Configure host power' -ForegroundColor Green
Write-Host ('Layout: ' + $Layout + '  ForceHost: ' + [bool]$ForceHost)
Write-Host 'Scope: AC / plugged-in only. Battery (DC) timeouts stay as they are.'
Write-Host ''

if ($Layout -ne 'Smith' -and -not $ForceHost) {
    Write-Host 'Skipping. This helper is for the Smith 24/7 desktop host only.' -ForegroundColor Yellow
    Write-Host 'Laptop power settings are left alone so the battery profile is not bricked.'
    Write-Host 'Re-run with -Layout Smith (or -ForceHost if you really mean this PC).'
    Write-Host 'One-liner for Smith:'
    Write-Host '  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\Configure-HostPower.ps1 -Layout Smith'
    exit 2
}

if ($Layout -ne 'Smith' -and $ForceHost) {
    Write-Host 'ForceHost: applying Smith AC sleep-never settings on this PC.' -ForegroundColor Yellow
    Write-Host 'Battery (DC) scheme is still not changed. Use this only if this box is the host.'
}

Write-Host 'Intended AC (plugged in) settings for the current scheme:'
Write-Host '  Sleep timeout: never (0 minutes)'
Write-Host '  Hibernate timeout: never (0 minutes)'
Write-Host '  Wake timers: enabled (RTCWAKE)'
Write-Host '  Hibernate feature: try off (needs admin; ignored if denied)'
Write-Host '  DC / battery: unchanged'
Write-Host ''

if ($DryRun) {
    Write-Host '[DryRun] Would run:'
    Write-Host '  powercfg /CHANGE standby-timeout-ac 0'
    Write-Host '  powercfg /CHANGE hibernate-timeout-ac 0'
    Write-Host '  powercfg /SETACVALUEINDEX SCHEME_CURRENT SUB_SLEEP RTCWAKE 1'
    Write-Host '  powercfg /SETACTIVE SCHEME_CURRENT'
    Write-Host '  powercfg /HIBERNATE OFF   (soft fail if not elevated)'
    Write-Host 'No power settings were changed.'
    exit 0
}

& powercfg.exe /CHANGE standby-timeout-ac 0
if ($LASTEXITCODE -ne 0) { throw 'powercfg standby-timeout-ac failed' }
& powercfg.exe /CHANGE hibernate-timeout-ac 0
if ($LASTEXITCODE -ne 0) { throw 'powercfg hibernate-timeout-ac failed' }
& powercfg.exe /SETACVALUEINDEX SCHEME_CURRENT SUB_SLEEP RTCWAKE 1
if ($LASTEXITCODE -ne 0) {
    Write-Host 'Wake timers (RTCWAKE) could not be set. Sleep-never still applied.' -ForegroundColor Yellow
}
& powercfg.exe /SETACTIVE SCHEME_CURRENT
if ($LASTEXITCODE -ne 0) { throw 'powercfg SETACTIVE failed' }

$prevError = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& powercfg.exe /HIBERNATE OFF
$hiber = $LASTEXITCODE
$ErrorActionPreference = $prevError
if ($hiber -ne 0) {
    Write-Host 'Hibernate-off skipped (often needs Administrator). AC hibernate timeout is still never.' -ForegroundColor Yellow
} else {
    Write-Host 'Hibernate feature: off'
}

Write-PowerQuery

Write-Host ''
Write-Host 'Smith should stay awake on AC for LAN / Tailscale hosting.' -ForegroundColor Green
Write-Host 'Manual check: Settings > System > Power > Screen and sleep > When plugged in, never.'
Write-Host 'Ollama stays 127.0.0.1:11434. This script does not touch Agent Smith models.'
exit 0
