# Packs the built floe-desktop.exe into an UNSIGNED .msix for Microsoft Store
# submission. The Store re-signs the package with a Microsoft certificate on
# publication, so no local signing step exists on purpose. The output cannot
# be installed directly by end users (Windows refuses unsigned exe-activation
# packages); its only consumer is Partner Center. Local testing uses the
# loose-layout path instead:
#   Add-AppxPackage -Register <layout>\AppxManifest.xml   (Developer Mode)
#
# Usage: pack.ps1 -Version 0.2.0 [-ExePath ...] [-OutDir ...]
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$ExePath = (Join-Path $PSScriptRoot '..\bin\floe-desktop.exe'),
    [string]$OutDir = 'dist-msix'
)

$ErrorActionPreference = 'Stop'

if ($Version -notmatch '^([0-9]+)\.([0-9]+)\.([0-9]+)$') {
    throw "Version must be strictly numeric X.Y.Z, got '$Version'"
}
# The Store rejects an Identity Version whose first octet is 0 and reserves
# the fourth octet. (major+1).minor.patch.0 keeps the mapping mechanical and
# monotonic: 0.1.0 -> 1.1.0.0, 0.2.0 -> 1.2.0.0, 1.0.0 -> 2.0.0.0.
$identityVersion = '{0}.{1}.{2}.0' -f ([int]$Matches[1] + 1), $Matches[2], $Matches[3]

if (-not (Test-Path $ExePath)) {
    throw "exe not found: $ExePath (run wails build first)"
}

# makeappx ships with the Windows SDK; take the newest installed kit.
$makeappx = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\makeappx.exe" -ErrorAction SilentlyContinue |
    Sort-Object { [version]($_.Directory.Parent.Name) } -Descending |
    Select-Object -First 1 -ExpandProperty FullName
if (-not $makeappx) {
    throw 'makeappx.exe not found under Windows Kits; install the Windows SDK'
}

New-Item -ItemType Directory -Force $OutDir | Out-Null
$layout = Join-Path $OutDir 'layout'
if (Test-Path $layout) { Remove-Item $layout -Recurse -Force }
New-Item -ItemType Directory ($layout + '\Assets') -Force | Out-Null

Copy-Item $ExePath (Join-Path $layout 'floe-desktop.exe')
Copy-Item (Join-Path $PSScriptRoot 'assets\*.png') (Join-Path $layout 'Assets')
$manifest = Get-Content (Join-Path $PSScriptRoot 'AppxManifest.xml') -Raw
$manifest = $manifest.Replace('__IDENTITY_VERSION__', $identityVersion)
# BOM-free UTF-8: makeappx accepts either, but keep the layout byte-stable.
[System.IO.File]::WriteAllText((Join-Path $layout 'AppxManifest.xml'), $manifest, [System.Text.UTF8Encoding]::new($false))

$msix = Join-Path $OutDir ("FloeDesktop_" + $identityVersion + "_x64.msix")
if (Test-Path $msix) { Remove-Item $msix -Force }
& $makeappx pack /o /d $layout /p $msix
if ($LASTEXITCODE -ne 0) { throw "makeappx failed with exit code $LASTEXITCODE" }

$hash = (Get-FileHash $msix -Algorithm SHA256).Hash.ToLower()
Write-Output ("packed: " + $msix)
Write-Output ("identity version: " + $identityVersion)
Write-Output ("sha256: " + $hash)
