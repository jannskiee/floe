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

# makeappx and makepri ship with the Windows SDK; take the newest installed kit.
function Resolve-SdkTool([string]$exe) {
    $found = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\$exe" -ErrorAction SilentlyContinue |
        Sort-Object { [version]($_.Directory.Parent.Name) } -Descending |
        Select-Object -First 1 -ExpandProperty FullName
    if (-not $found) { throw "$exe not found under Windows Kits; install the Windows SDK" }
    $found
}
$makeappx = Resolve-SdkTool 'makeappx.exe'
$makepri = Resolve-SdkTool 'makepri.exe'

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

# Without altform-unplated variants Windows paints a solid plate behind the
# 44x44 logo on the taskbar, Start, search and Alt+Tab. That plate is the
# reason the Store build shipped with a coloured square around the icon, so
# refuse to build a package that would reintroduce it. Regenerate with
# gen-assets.ps1 if this trips.
$unplated = @(Get-ChildItem (Join-Path $layout 'Assets') -Filter '*_altform-unplated.png' -ErrorAction SilentlyContinue)
if ($unplated.Count -lt 1) {
    throw 'no *_altform-unplated.png assets in the layout; run desktop/build/msix/gen-assets.ps1'
}

# Qualified filenames (scale-*, targetsize-*, altform-*) are inert on their
# own: makeappx neither writes nor reads a resource index, so without a
# resources.pri Windows only ever resolves the literal paths in the manifest
# and every variant above is dead weight. Build the index outside the layout
# so neither the config nor the .pri gets indexed into itself, then copy only
# the .pri into the package root (where the Store requires it to live).
$priConfig = Join-Path $OutDir 'priconfig.xml'
$priFile = Join-Path $OutDir 'resources.pri'
# /o overwrites without prompting; MakePri blocks on an interactive
# "Overwrite? [Y]es" otherwise, which would hang CI rather than fail it.
# /dq must agree with the manifest's <Resource Language="en-us" />.
& $makepri createconfig /cf $priConfig /dq en-US /pv 10.0.0 /o
if ($LASTEXITCODE -ne 0) { throw "makepri createconfig failed with exit code $LASTEXITCODE" }

# createconfig emits <autoResourcePackage> rules that split scale-qualified
# candidates out into sibling resources.scale-*.pri files, which only mean
# something inside a bundle's resource packages. Floe ships one flat .msix, so
# those siblings are never packed and every scale-* asset silently drops out of
# the index (makepri reports "Scale Qualifiers: 125,150,200,400" while the
# resources.pri it hands back contains none of them). Drop the packaging block
# so a single index carries every candidate.
[xml]$priCfg = Get-Content $priConfig -Raw
$packagingNode = $priCfg.resources.packaging
if ($packagingNode) { [void]$priCfg.resources.RemoveChild($packagingNode) }
$priCfg.Save($priConfig)

# Run against $layout, not the source tree: the resource map is named from the
# Identity in the manifest sitting at the project root, and a mismatch there
# fails at install time on the user's machine rather than at certification.
# No /am (AutoMerge) and no /rm (ReverseMap): both are hard Store
# certification failures.
& $makepri new /pr $layout /cf $priConfig /of $priFile /o
if ($LASTEXITCODE -ne 0) { throw "makepri new failed with exit code $LASTEXITCODE" }
if (-not (Test-Path $priFile)) { throw "makepri reported success but produced no $priFile" }
Copy-Item $priFile (Join-Path $layout 'resources.pri')

# makepri exits 0 when it indexes nothing at all, and makeappx will happily
# pack an empty index. That failure is invisible: the package installs, passes
# certification, and still draws a plated icon, so the bug would only resurface
# on a user's taskbar a full certification cycle later. Read the index back and
# assert the candidates that actually matter are in it.
$priDump = Join-Path $OutDir 'resources-dump'
& $makepri dump /if $priFile /of $priDump /o
if ($LASTEXITCODE -ne 0) { throw "makepri dump failed with exit code $LASTEXITCODE" }
$dumpFile = Get-ChildItem "$priDump*" -File | Select-Object -First 1
if (-not $dumpFile) { throw "makepri dump produced no output next to $priDump" }
$dump = Get-Content $dumpFile.FullName -Raw
foreach ($needle in @('AlternateForm-UNPLATED', 'AlternateForm-LIGHTUNPLATED', 'Scale-200')) {
    if ($dump -notmatch [regex]::Escape($needle)) {
        throw "resources.pri indexes no $needle candidate; the shipped icon would still be plated"
    }
}
Write-Output ("indexed: " + ([regex]::Matches($dump, 'qualifiers=')).Count + " qualified resource candidates")

$msix = Join-Path $OutDir ("FloeDesktop_" + $identityVersion + "_x64.msix")
if (Test-Path $msix) { Remove-Item $msix -Force }
& $makeappx pack /o /d $layout /p $msix
if ($LASTEXITCODE -ne 0) { throw "makeappx failed with exit code $LASTEXITCODE" }

$hash = (Get-FileHash $msix -Algorithm SHA256).Hash.ToLower()
Write-Output ("packed: " + $msix)
Write-Output ("identity version: " + $identityVersion)
Write-Output ("sha256: " + $hash)
