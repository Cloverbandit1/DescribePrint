# Build dist\AllosWorstation-portable\ + zip (setup pack).
# Wrapper around scripts/build-portable.mjs - prefer this on Windows.
[CmdletBinding()]
param(
    [string]$Root,
    [string]$Out,
    [string]$Zip,
    [switch]$FetchOpenScad,
    [switch]$SkipZip
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Repo = if ($Root) { $Root } else { (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    throw 'Node.js is required to build the portable pack. Install LTS from https://nodejs.org'
}

$script = Join-Path $Repo 'scripts\build-portable.mjs'
$argsList = @($script, '--root', $Repo)
if ($Out) { $argsList += @('--out', $Out) }
if ($Zip) { $argsList += @('--zip', $Zip) }
if ($FetchOpenScad) { $argsList += '--fetch-openscad' }
if ($SkipZip) { $argsList += '--skip-zip' }

Write-Host 'AllosWorstation - Build-Portable' -ForegroundColor Green
& node @argsList
exit $LASTEXITCODE
