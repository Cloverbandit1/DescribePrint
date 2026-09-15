# First-run setup from a portable zip or git clone (this tree).
# Ensures .env.local, vendor OpenSCAD, npm install, Desktop bat, health preflight.
[CmdletBinding()]
param(
    [ValidateSet("Smith", "Laptop", "Current")]
    [string]$Layout = "Current",
    [string]$Model = "qwen2.5-coder:32b",
    [switch]$Start,
    [switch]$AutoStart,
    [switch]$NoAutoStart,
    [switch]$RemoveAutoStart,
    [ValidateSet('Task', 'Startup')]
    [string]$AutoStartMethod = 'Task',
    [switch]$SkipHostPower
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$installer = Join-Path $PSScriptRoot 'Install-AllosWorstation.ps1'
$extra = @{
    AutoStartMethod = $AutoStartMethod
}
if ($Start) { $extra['Start'] = $true }
if ($AutoStart) { $extra['AutoStart'] = $true }
if ($NoAutoStart) { $extra['NoAutoStart'] = $true }
if ($RemoveAutoStart) { $extra['RemoveAutoStart'] = $true }
if ($SkipHostPower) { $extra['SkipHostPower'] = $true }
& $installer -Layout $Layout -Model $Model @extra
exit $LASTEXITCODE
