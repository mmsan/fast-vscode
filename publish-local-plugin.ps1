[CmdletBinding()]
param(
    [switch]$NoVersionBump,
    [switch]$SkipInstall,
    [string]$CodeCommand = 'code.cmd'
)

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$packagePath = Join-Path $projectRoot 'package.json'
$lockPath = Join-Path $projectRoot 'package-lock.json'
$originalPackage = [IO.File]::ReadAllText($packagePath)
$originalLock = if (Test-Path -LiteralPath $lockPath) { [IO.File]::ReadAllText($lockPath) } else { $null }
$versionChanged = $false

try {
    $manifest = $originalPackage | ConvertFrom-Json
    if ([string]$manifest.version -notmatch '^(\d+)\.(\d+)\.(\d+)$') {
        throw 'package.json version must use x.y.z format.'
    }

    if ($NoVersionBump) {
        $version = [string]$manifest.version
    } else {
        $npm = Get-Command 'npm.cmd' -ErrorAction Stop
        & $npm.Source version patch --no-git-tag-version
        if ($LASTEXITCODE -ne 0) { throw "npm version failed with exit code $LASTEXITCODE." }
        $versionChanged = $true
        $version = [string](([IO.File]::ReadAllText($packagePath) | ConvertFrom-Json).version)
    }

    $npm = Get-Command 'npm.cmd' -ErrorAction Stop
    $npmCache = Join-Path ([IO.Path]::GetTempPath()) 'fast-vscode-npm-cache'
    & $npm.Source --cache $npmCache install --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE." }

    $artifact = Join-Path $projectRoot "scs-$version.vsix"
    & $npm.Source --cache $npmCache exec --yes -- '@vscode/vsce' package --out $artifact
    if ($LASTEXITCODE -ne 0) { throw "VSIX packaging failed with exit code $LASTEXITCODE." }
    if (-not (Test-Path -LiteralPath $artifact)) { throw "VSIX was not created: $artifact" }

    if (-not $SkipInstall) {
        $code = Get-Command $CodeCommand -ErrorAction Stop
        & $code.Source --install-extension $artifact --force
        if ($LASTEXITCODE -ne 0) { throw "VS Code extension installation failed with exit code $LASTEXITCODE." }
    }

    $file = Get-Item -LiteralPath $artifact
    Write-Host "Local plugin version: $version" -ForegroundColor Green
    Write-Host "VSIX: $($file.FullName) ($($file.Length) bytes)"
    if ($SkipInstall) {
        Write-Host 'Installation was skipped.'
    } else {
        Write-Host 'Installation completed. Run Developer: Reload Window in VS Code to load the new version.' -ForegroundColor Yellow
    }
} catch {
    if ($versionChanged) {
        [IO.File]::WriteAllText($packagePath, $originalPackage, [Text.UTF8Encoding]::new($false))
        if ($null -ne $originalLock) {
            [IO.File]::WriteAllText($lockPath, $originalLock, [Text.UTF8Encoding]::new($false))
        }
    }
    throw
}
