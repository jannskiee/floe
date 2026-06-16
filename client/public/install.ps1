# Floe CLI installer for Windows
# Usage: irm https://floe.one/install.ps1 | iex
#        $env:FLOE_VERSION = "v1.2.0"; irm https://floe.one/install.ps1 | iex
# Re-running upgrades an existing install in place.

$ErrorActionPreference = "Stop"

$Repo = "jannskiee/floe"
$Binary = "floe.exe"
$InstallDir = "$env:LOCALAPPDATA\Programs\floe"

# Detect architecture
$Arch = switch ($env:PROCESSOR_ARCHITECTURE) {
    "AMD64" { "amd64" }
    "ARM64" { "arm64" }
    default {
        Write-Error "Unsupported architecture: $env:PROCESSOR_ARCHITECTURE"
        exit 1
    }
}

# Resolve version
$Version = $env:FLOE_VERSION
if (-not $Version) {
    Write-Host "Fetching latest version..."
    $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest"
    $Version = $Release.tag_name
}

if (-not $Version) {
    Write-Error "Could not determine latest version. Set `$env:FLOE_VERSION = 'vX.Y.Z'` to install a specific version."
    exit 1
}

$Archive = "floe_${Version}_windows_${Arch}.zip"
$DownloadUrl = "https://github.com/$Repo/releases/download/$Version/$Archive"
$ChecksumsUrl = "https://github.com/$Repo/releases/download/$Version/checksums.txt"

$TmpDir = New-Item -ItemType Directory -Path "$env:TEMP\floe-install-$(Get-Random)"

try {
    $ArchivePath = Join-Path $TmpDir $Archive

    Write-Host "Downloading floe $Version (windows/$Arch)..."
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $ArchivePath -UseBasicParsing

    # Verify SHA-256 checksum
    Write-Host "Verifying checksum..."
    $ChecksumsRaw = (Invoke-WebRequest -Uri $ChecksumsUrl -UseBasicParsing).Content
    $Lines = $ChecksumsRaw -split "`r?`n"
    $MatchLine = $Lines | Where-Object { $_ -match "\s+$([regex]::Escape($Archive))\s*$" }

    if ($MatchLine) {
        $ExpectedHash = ($MatchLine.Trim() -split "\s+")[0].ToLower()
        $ActualHash = (Get-FileHash -Algorithm SHA256 -Path $ArchivePath).Hash.ToLower()
        if ($ActualHash -ne $ExpectedHash) {
            Write-Error "Checksum verification failed.`n  Expected: $ExpectedHash`n  Got:      $ActualHash"
            exit 1
        }
        Write-Host "Checksum verified."
    } else {
        Write-Warning "Checksum not found for $Archive, skipping verification."
    }

    # Extract
    Write-Host "Extracting..."
    Expand-Archive -Path $ArchivePath -DestinationPath $TmpDir -Force

    $ExtractedBinary = Join-Path $TmpDir $Binary
    if (-not (Test-Path $ExtractedBinary)) {
        Write-Error "$Binary not found in archive."
        exit 1
    }

    # Install
    if (-not (Test-Path $InstallDir)) {
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    }
    Copy-Item -Path $ExtractedBinary -Destination (Join-Path $InstallDir $Binary) -Force

    # Add install directory to user PATH (idempotent)
    $CurrentPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($CurrentPath -notlike "*$InstallDir*") {
        $NewPath = ($CurrentPath.TrimEnd(";") + ";$InstallDir").TrimStart(";")
        [Environment]::SetEnvironmentVariable("Path", $NewPath, "User")
        Write-Host "Added $InstallDir to your PATH."
    }

    Write-Host ""
    Write-Host "Installed floe $Version to $InstallDir\$Binary"
    Write-Host "Open a new terminal, then run 'floe version' to verify."

} finally {
    Remove-Item -Recurse -Force $TmpDir -ErrorAction SilentlyContinue
}
