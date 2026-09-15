# First-run setup from a portable zip or git clone (this tree).
# Ensures .env.local, vendor OpenSCAD, npm install, Desktop bat, health preflight.
[CmdletBinding()]
param(
    [ValidateSet("Smith", "Laptop", "Current")]
    [string]$Layout = "Current",
    [string]$Model = "qwen2.5-coder:32b",
    [switch]$Start
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$installer = Join-Path $PSScriptRoot 'Install-AllosWorstation.ps1'
$extra = @{}
if ($Start) { $extra['Start'] = $true }
& $installer -Layout $Layout -Model $Model @extra
exit $LASTEXITCODE
