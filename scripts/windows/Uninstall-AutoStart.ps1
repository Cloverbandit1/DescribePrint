# Remove DescribePrint auto-start (Task Scheduler task and/or Startup shortcut).
[CmdletBinding()]
param(
    [switch]$DryRun
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$installer = Join-Path $PSScriptRoot 'Install-AutoStart.ps1'
if ($DryRun) {
    & $installer -Remove -DryRun
} else {
    & $installer -Remove
}
exit $LASTEXITCODE
