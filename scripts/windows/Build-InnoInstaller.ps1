# Build dist\AllosWorstation-DescribePrint-Setup.exe (optional Inno Setup wrapper).
# Portable zip remains the supported Windows path. This helper is optional.
# Does not bundle Node. Does not change Ollama port or Agent Smith models.
[CmdletBinding()]
param(
    [string]$Root,
    [switch]$SkipAutoPack
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Find-Iscc {
    $names = @(
        'Inno Setup 6\ISCC.exe'
    )
    $roots = @()
    if (${env:ProgramFiles(x86)}) { $roots += ${env:ProgramFiles(x86)} }
    if ($env:ProgramFiles) { $roots += $env:ProgramFiles }
    if ($env:LOCALAPPDATA) {
        $roots += (Join-Path $env:LOCALAPPDATA 'Programs')
    }
    foreach ($base in $roots) {
        foreach ($name in $names) {
            $candidate = Join-Path $base $name
            if (Test-Path -LiteralPath $candidate) {
                return $candidate
            }
        }
    }
    $cmd = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) {
        return $cmd.Source
    }
    return $null
}

$Repo = if ($Root) { $Root } else { (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
$Iss = Join-Path $Repo 'packaging\windows\AllosWorstation.iss'
$PortableDir = Join-Path $Repo 'dist\AllosWorstation-portable'
$PortableMarker = Join-Path $PortableDir 'Start-DescribePrint.cmd'
$OutputExe = Join-Path $Repo 'dist\AllosWorstation-DescribePrint-Setup.exe'

Write-Host 'AllosWorstation - Build-InnoInstaller (optional)' -ForegroundColor Green
Write-Host ('Repo: ' + $Repo)

if (-not (Test-Path -LiteralPath $Iss)) {
    throw ('Missing Inno script: ' + $Iss)
}

if (-not (Test-Path -LiteralPath $PortableMarker)) {
    if ($SkipAutoPack) {
        throw (
            'Portable folder missing: dist\AllosWorstation-portable\' + [Environment]::NewLine +
            'Run: npm run pack:windows' + [Environment]::NewLine +
            'then re-run this script.'
        )
    }
    Write-Host 'Portable folder missing. Running npm run pack:windows -- --skip-zip ...'
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        throw 'npm is required to build the portable folder. Install Node.js LTS from https://nodejs.org'
    }
    Push-Location $Repo
    try {
        & npm run pack:windows -- --skip-zip
        if ($LASTEXITCODE -ne 0) {
            throw ('npm run pack:windows failed with exit ' + $LASTEXITCODE)
        }
    } finally {
        Pop-Location
    }
    if (-not (Test-Path -LiteralPath $PortableMarker)) {
        throw 'npm run pack:windows finished but Start-DescribePrint.cmd is still missing under dist\AllosWorstation-portable\'
    }
}

$iscc = Find-Iscc
if (-not $iscc) {
    throw (
        'Inno Setup (ISCC.exe) was not found.' + [Environment]::NewLine +
        'Install Inno Setup 6 from https://jrsoftware.org/isinfo.php' + [Environment]::NewLine +
        'then re-run: npm run pack:windows:installer' + [Environment]::NewLine +
        'or compile packaging\windows\AllosWorstation.iss in the Inno IDE.' + [Environment]::NewLine +
        'Portable zip remains the supported path (npm run pack:windows).'
    )
}

Write-Host ('ISCC: ' + $iscc)

$version = '0.1.0'
$pkgJson = Join-Path $Repo 'package.json'
if (Test-Path -LiteralPath $pkgJson) {
    $pkgText = Get-Content -LiteralPath $pkgJson -Raw
    if ($pkgText -match '"version"\s*:\s*"([^"]+)"') {
        $version = $Matches[1]
    }
}

Write-Host ('Compiling ' + $Iss)
& $iscc ('/DMyAppVersion=' + $version) $Iss
if ($LASTEXITCODE -ne 0) {
    throw ('ISCC failed with exit ' + $LASTEXITCODE)
}

if (-not (Test-Path -LiteralPath $OutputExe)) {
    throw ('ISCC finished but output is missing: ' + $OutputExe)
}

Write-Host ''
Write-Host ('Installer: ' + $OutputExe) -ForegroundColor Green
Write-Host 'This Setup.exe wraps the portable folder. It does not bundle Node.'
Write-Host 'MSI is a follow-up. Portable zip remains the supported path.'
exit 0
