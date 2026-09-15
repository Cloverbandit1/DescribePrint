# Register DescribePrint to start at Windows user logon.
# Default: Task Scheduler AtLogOn for the current user (cleaner than Startup).
# Alternate: Startup-folder shortcut to Start-DescribePrint.cmd.
# This is a user-session start (QR / Next.js need a logon). Not a service.
# Smith (24/7 host) enables this by default via Install-AllosWorstation.ps1.
[CmdletBinding()]
param(
    [string]$RepoPath,
    [ValidateSet('Task', 'Startup')]
    [string]$Method = 'Task',
    [switch]$Remove,
    [switch]$DryRun
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$TaskName = 'AllosWorstation-DescribePrint'
$ShortcutName = 'Start DescribePrint.lnk'

function Get-RepoRoot {
    if ($RepoPath) {
        return (Resolve-Path -LiteralPath $RepoPath).Path
    }
    return (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}

function Get-StartupShortcutPath {
    $startup = [Environment]::GetFolderPath('Startup')
    if (-not $startup) {
        $startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
    }
    return (Join-Path $startup $ShortcutName)
}

function Test-ScheduledTaskName([string]$Name) {
    try {
        $null = Get-ScheduledTask -TaskName $Name -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Remove-AutoStartRegistration {
    $shortcut = Get-StartupShortcutPath
    $hadTask = Test-ScheduledTaskName $TaskName
    $hadShortcut = Test-Path -LiteralPath $shortcut

    if ($DryRun) {
        Write-Host '[DryRun] Would remove auto-start:'
        if ($hadTask) {
            Write-Host ('  Unregister-ScheduledTask ' + $TaskName)
        } else {
            Write-Host ('  Task not present: ' + $TaskName)
        }
        if ($hadShortcut) {
            Write-Host ('  Remove Startup shortcut: ' + $shortcut)
        } else {
            Write-Host ('  Startup shortcut not present: ' + $shortcut)
        }
        return
    }

    if ($hadTask) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host ('Removed scheduled task: ' + $TaskName) -ForegroundColor Green
    } else {
        Write-Host ('Scheduled task not present: ' + $TaskName)
    }

    if ($hadShortcut) {
        Remove-Item -LiteralPath $shortcut -Force
        Write-Host ('Removed Startup shortcut: ' + $shortcut) -ForegroundColor Green
    } else {
        Write-Host ('Startup shortcut not present: ' + $shortcut)
    }
}

function Install-TaskAutoStart([string]$Repo, [string]$StartCmd) {
    $arg = '/c "' + $StartCmd + '"'
    if ($DryRun) {
        Write-Host '[DryRun] Would register Task Scheduler AtLogOn:'
        Write-Host ('  Name: ' + $TaskName)
        Write-Host ('  cmd.exe ' + $arg)
        Write-Host ('  WorkingDirectory: ' + $Repo)
        Write-Host '  Trigger: current user logon (interactive session)'
        Write-Host '  ExecutionTimeLimit: none (Next.js stays up)'
        return
    }

    $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $arg -WorkingDirectory $Repo
    $user = [Environment]::UserName
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -MultipleInstances IgnoreNew
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $description = 'Start DescribePrint (AllosWorstation) at logon. Smith is the 24/7 host.'

    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Principal $principal `
        -Description $description `
        -Force | Out-Null

    Write-Host ('Registered scheduled task: ' + $TaskName) -ForegroundColor Green
    Write-Host ('  Starts at logon for ' + $user)
    Write-Host ('  Target: ' + $StartCmd)
}

function Install-StartupShortcut([string]$Repo, [string]$StartCmd) {
    $shortcut = Get-StartupShortcutPath
    if ($DryRun) {
        Write-Host '[DryRun] Would write Startup-folder shortcut:'
        Write-Host ('  ' + $shortcut)
        Write-Host ('  Target: ' + $StartCmd)
        Write-Host ('  WorkingDirectory: ' + $Repo)
        return
    }

    $folder = Split-Path -Parent $shortcut
    if (-not (Test-Path -LiteralPath $folder)) {
        New-Item -ItemType Directory -Path $folder -Force | Out-Null
    }

    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($shortcut)
    $link.TargetPath = $StartCmd
    $link.WorkingDirectory = $Repo
    $link.WindowStyle = 1
    $link.Description = 'Start DescribePrint (AllosWorstation)'
    $link.Save()

    Write-Host ('Wrote Startup shortcut: ' + $shortcut) -ForegroundColor Green
    Write-Host ('  Target: ' + $StartCmd)
}

if ($Remove) {
    Write-Host 'AllosWorstation - Uninstall auto-start' -ForegroundColor Green
    Remove-AutoStartRegistration
    exit 0
}

$Repo = Get-RepoRoot
$StartCmd = Join-Path $Repo 'Start-DescribePrint.cmd'
if (-not (Test-Path -LiteralPath $StartCmd)) {
    throw ('Start-DescribePrint.cmd not found: ' + $StartCmd)
}

Write-Host 'AllosWorstation - Install auto-start' -ForegroundColor Green
Write-Host ('Repo: ' + $Repo)
Write-Host ('Method: ' + $Method + ' (user logon; Next.js + LAN/Tailscale QR need a session)')
Write-Host 'Laptop should not enable this unless you passed -AutoStart on purpose.'
Write-Host ''

if ($Method -eq 'Task') {
    if (-not $DryRun) {
        $shortcut = Get-StartupShortcutPath
        if (Test-Path -LiteralPath $shortcut) {
            Remove-Item -LiteralPath $shortcut -Force
            Write-Host ('Removed leftover Startup shortcut so the task is the only starter.')
        }
    }
    Install-TaskAutoStart $Repo $StartCmd
} else {
    if (-not $DryRun -and (Test-ScheduledTaskName $TaskName)) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host ('Removed leftover scheduled task so the Startup shortcut is the only starter.')
    }
    Install-StartupShortcut $Repo $StartCmd
}

Write-Host ''
Write-Host 'Uninstall: scripts\windows\Uninstall-AutoStart.ps1   or   Install-AutoStart.ps1 -Remove'
Write-Host 'Start still prints the LAN / Tailscale QR (print-lan-access.mjs). Ollama stays 127.0.0.1:11434.'
exit 0
