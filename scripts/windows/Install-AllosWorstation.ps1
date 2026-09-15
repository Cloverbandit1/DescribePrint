# Bootstrap AllosWorstation / DescribePrint on this Windows machine.
# Creates Desktop\AllosWorstation\Start DescribePrint.bat → repo Start-DescribePrint.cmd
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

$Repo = if ($Source) { $Source } else { (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js is required. Install LTS from https://nodejs.org"
}

if ($Model -match "minicpm5|smith-") {
    throw "Refusing Agent Smith model '$Model'. Use qwen2.5-coder:32b (or 14b / 7b). Leave Smith models untouched."
}

$Desktop = [Environment]::GetFolderPath("Desktop")
if (-not $Desktop) {
    if ($env:OneDrive -and (Test-Path (Join-Path $env:OneDrive "Desktop"))) {
        $Desktop = Join-Path $env:OneDrive "Desktop"
    } else {
        $Desktop = Join-Path $env:USERPROFILE "Desktop"
    }
}

$argsList = @(
    (Join-Path $Repo "scripts\install-allos.mjs"),
    "--source", $Repo,
    "--layout", $Layout.ToLowerInvariant(),
    "--desktop", $Desktop,
    "--user-profile", $env:USERPROFILE,
    "--model", $Model
)
if ($RepoPath) { $argsList += @("--repo-path", $RepoPath) }
if ($SkipOpenScad) { $argsList += "--skip-openscad" }
if ($SkipNpm) { $argsList += "--skip-npm" }
if ($SkipHealth) { $argsList += "--skip-health" }
if ($SkipDesktop) { $argsList += "--skip-desktop" }
if ($PreferSystemOpenScad) { $argsList += "--prefer-system-openscad" }
if ($Start) { $argsList += "--start" }
if ($DryRun) { $argsList += "--dry-run" }

Write-Host "AllosWorstation — Install ($Layout)" -ForegroundColor Green
Write-Host "Desktop: $Desktop"
Write-Host "Laptop default target: $env:USERPROFILE\AllosWorstation\DescribePrint"
Write-Host "Smith often stays on OneDrive Desktop\AllosWorstation\DescribePrint"
Write-Host ""
& node @argsList
exit $LASTEXITCODE
