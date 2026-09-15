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
    [switch]$DryRun,
    [switch]$AutoStart,
    [switch]$NoAutoStart,
    [switch]$RemoveAutoStart,
    [ValidateSet('Task', 'Startup')]
    [string]$AutoStartMethod = 'Task',
    [switch]$SkipHostPower,
    [switch]$ConfigureHostPower
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
Write-Host 'Smith desktop is the 24/7 AllosWorstation host (not the laptop).'
Write-Host 'Desktop bat is a shared launcher (safe to OneDrive-sync). This-machine hint:'
Write-Host ('  ' + $MachineHint)
Write-Host ''
& node @argsList
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

$autoScript = Join-Path $PSScriptRoot 'Install-AutoStart.ps1'
$unautoScript = Join-Path $PSScriptRoot 'Uninstall-AutoStart.ps1'
$powerScript = Join-Path $PSScriptRoot 'Configure-HostPower.ps1'

$hintRepo = $null
if (-not $DryRun -and (Test-Path -LiteralPath $MachineHint)) {
    $hintLine = (Get-Content -LiteralPath $MachineHint -TotalCount 1)
    if ($hintLine) { $hintRepo = $hintLine.Trim() }
}

$autoRepo = $Repo
if ($RepoPath) {
    $autoRepo = $RepoPath
} elseif ($hintRepo) {
    $autoRepo = $hintRepo
} elseif ($Layout -eq 'Laptop') {
    $autoRepo = $LaptopTarget
}

$enableAutoStart = $false
if ($RemoveAutoStart) {
    Write-Host ''
    Write-Host 'Removing auto-start (task and Startup shortcut)...'
    if ($DryRun) {
        & $unautoScript -DryRun
    } else {
        & $unautoScript
    }
} else {
    if ($AutoStart) {
        $enableAutoStart = $true
    } elseif ($NoAutoStart) {
        $enableAutoStart = $false
    } elseif ($Layout -eq 'Smith') {
        $enableAutoStart = $true
    }

    Write-Host ''
    if ($enableAutoStart) {
        Write-Host ('Registering auto-start at logon (' + $AutoStartMethod + ') for ' + $autoRepo)
        $autoArgs = @{
            RepoPath = $autoRepo
            Method   = $AutoStartMethod
        }
        if ($DryRun) { $autoArgs['DryRun'] = $true }
        & $autoScript @autoArgs
    } else {
        Write-Host 'Auto-start skipped.'
        if ($Layout -eq 'Laptop') {
            Write-Host 'Laptop is not the 24/7 host. Pass -AutoStart only if you want logon start here.'
        } elseif ($Layout -eq 'Current') {
            Write-Host 'Current layout does not auto-enable. Pass -AutoStart or use -Layout Smith.'
        } else {
            Write-Host 'Pass -AutoStart to enable, or omit -NoAutoStart on Smith.'
        }
    }
}

$runHostPower = $false
if ($Layout -eq 'Smith' -and -not $SkipHostPower) {
    $runHostPower = $true
} elseif ($ConfigureHostPower -and $Layout -eq 'Smith') {
    $runHostPower = $true
} elseif ($ConfigureHostPower) {
    Write-Host ''
    Write-Host 'Host power tweaks are Smith-only. Not applying on this layout.' -ForegroundColor Yellow
    Write-Host 'Laptop battery settings stay untouched. Use Configure-HostPower.ps1 -ForceHost only if this PC is the host.'
}

if ($runHostPower) {
    Write-Host ''
    Write-Host 'Configuring Smith host power (AC sleep never)...'
    $powerArgs = @{ Layout = 'Smith' }
    if ($DryRun) { $powerArgs['DryRun'] = $true }
    & $powerScript @powerArgs
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 2) {
        Write-Host ('Configure-HostPower exited ' + $LASTEXITCODE + ' (install still succeeded).') -ForegroundColor Yellow
    }
}

Write-Host ''
Write-Host 'Keep Ollama on 127.0.0.1:11434. Do not auto-kill Agent Smith models.'
exit 0
