[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    & "$PSScriptRoot\Install-Prerequisites.ps1" -CheckOnly
    if (-not $?) { throw 'Prerequisite checks failed.' }
    $version = & node.exe -p 'process.versions.node'
    if ($LASTEXITCODE -ne 0 -or [version]$version -lt [version]'22.0.0') {
        throw 'Node.js 22 or newer is required; use a maintained Node.js LTS release for deployment.'
    }
    & npm.cmd ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Locked dependency installation failed.' }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Application build failed.' }
    & npm.cmd run fhir:build
    if ($LASTEXITCODE -ne 0) { throw 'FHIR compilation failed.' }
    & npm.cmd run fhir:package
    if ($LASTEXITCODE -ne 0) { throw 'FHIR package creation failed.' }
    if (-not (Test-Path -LiteralPath '.env')) {
        & npm.cmd run configure
        if ($LASTEXITCODE -ne 0) { throw 'Initial configuration failed.' }
    }
    Write-Host 'Dependencies and build artifacts are installed. Services have not been started.'
    Write-Host 'Start the app with: npm.cmd run ops -- start'
} finally {
    Pop-Location
}
