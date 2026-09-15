# Download official OpenSCAD Windows zip into vendor\openscad (openscad.exe).
[CmdletBinding()]
param(
    [string]$Root,
    [string]$Url,
    [switch]$PreferSystem,
    [switch]$Force,
    [switch]$DryRun
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Repo = if ($Root) { $Root } else { (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js is required. Install LTS from https://nodejs.org"
}

$argsList = @((Join-Path $Repo "scripts\install-openscad-portable.mjs"), "--root", $Repo)
if ($Url) { $argsList += @("--url", $Url) }
if ($PreferSystem) { $argsList += "--prefer-system" }
if ($Force) { $argsList += "--force" }
if ($DryRun) { $argsList += "--dry-run" }

& node @argsList
exit $LASTEXITCODE
