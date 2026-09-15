# Bootstrap AllosWorstation / DescribePrint on this Windows machine.
# Writes Desktop\AllosWorstation\Start DescribePrint.bat (OneDrive-safe launcher)
# plus %LOCALAPPDATA%\AllosWorstation\repo-path.txt for this machine's repo.
[CmdletBinding()]
param(
    [ValidateSet("Smith", "Laptop", "Current")]
    [string]$Layout = "Current",
    [string]$RepoPath,
    [string]$Source,
    [string]$Model = "qwen2.5-coder:32b",
    [switch]$SkipOpenScad,
    [switch]$SkipNpm,
    [switch]$SkipHealth,
    [switch]$SkipDesktop,
    [switch]$PreferSystemOpenScad,
    [switch]$Start,
    [switch]$DryRun
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Repo = if ($Source) { $Source } else { (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js is required. Install LTS from https://nodejs.org'
}

if ($Model -match 'minicpm5|smith-') {
    throw "Refusing Agent Smith model '$Model'. Use qwen2.5-coder:32b (or 14b / 7b). Leave Smith models untouched."
}

$Desktop = [Environment]::GetFolderPath('Desktop')
if (-not $Desktop) {
    if ($env:OneDrive -and (Test-Path (Join-Path $env:OneDrive 'Desktop'))) {
        $Desktop = Join-Path $env:OneDrive 'Desktop'
    } else {
        $Desktop = Join-Path $env:USERPROFILE 'Desktop'
    }
}

$LocalAppData = $env:LOCALAPPDATA
if (-not $LocalAppData) {
    $LocalAppData = Join-Path $env:USERPROFILE 'AppData\Local'
}

$LaptopTarget = Join-Path $env:USERPROFILE 'AllosWorstation\DescribePrint'
$MachineHint = Join-Path $LocalAppData 'AllosWorstation\repo-path.txt'

$argsList = @(
    (Join-Path $Repo 'scripts\install-allos.mjs'),
    '--source', $Repo,
    '--layout', $Layout.ToLowerInvariant(),
    '--desktop', $Desktop,
    '--user-profile', $env:USERPROFILE,
    '--local-app-data', $LocalAppData,
    '--model', $Model
)
if ($RepoPath) { $argsList += @('--repo-path', $RepoPath) }
if ($SkipOpenScad) { $argsList += '--skip-openscad' }
if ($SkipNpm) { $argsList += '--skip-npm' }
if ($SkipHealth) { $argsList += '--skip-health' }
if ($SkipDesktop) { $argsList += '--skip-desktop' }
if ($PreferSystemOpenScad) { $argsList += '--prefer-system-openscad' }
if ($Start) { $argsList += '--start' }
if ($DryRun) { $argsList += '--dry-run' }

Write-Host "AllosWorstation - Install ($Layout)" -ForegroundColor Green
Write-Host "Desktop: $Desktop"
Write-Host ('Laptop default target: ' + $LaptopTarget)
Write-Host 'Smith often stays on OneDrive Desktop\AllosWorstation\DescribePrint'
Write-Host 'Desktop bat is a shared launcher (safe to OneDrive-sync). This-machine hint:'
Write-Host ('  ' + $MachineHint)
Write-Host ''
& node @argsList
exit $LASTEXITCODE
