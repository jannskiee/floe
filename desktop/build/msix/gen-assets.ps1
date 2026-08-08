# Generates the full MSIX icon asset set from build/appicon.png.
#
# Why this exists: Windows draws a solid "icon plate" behind Square44x44Logo on
# the taskbar, Start, search and Alt+Tab unless the package ships targetsize
# variants WITH altform-unplated twins. Shipping only the four unqualified
# logos is what put a coloured square behind the Floe icon in the Store build.
# The variants are inert on their own; pack.ps1 indexes them into a
# resources.pri, without which Windows only ever sees the literal manifest
# paths.
#
# Source geometry: appicon.png is 1024x1024 with the squircle inset 40px on
# every side (appicon.svg draws it as rect x=40 y=40 w=944 h=944).
#   - scale-*      assets keep that inset. They are drawn ON a plate, and
#                  Windows expects the art to sit inside it with margins.
#   - targetsize-* assets are full bleed, so the inset is cropped away. When
#                  unplated the squircle IS the container, the same way
#                  Spotify's circle and Terminal's rounded square are.
# All three targetsize families share the same art: the squircle already reads
# on both light and dark shells, and shipping an explicit altform-lightunplated
# candidate stops Windows falling back to a plate for contrast reasons.
#
# Usage: gen-assets.ps1 [-Source ...] [-OutDir ...]

param(
    [string]$Source = (Join-Path $PSScriptRoot '..\appicon.png'),
    [string]$OutDir = (Join-Path $PSScriptRoot 'assets')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if (-not (Test-Path $Source)) { throw "source icon not found: $Source" }
New-Item -ItemType Directory -Force $OutDir | Out-Null

$src = [System.Drawing.Bitmap]::FromFile((Resolve-Path $Source))
try {
    if ($src.Width -ne 1024 -or $src.Height -ne 1024) {
        throw "expected a 1024x1024 source, got $($src.Width)x$($src.Height)"
    }

    # The squircle's bounding box inside the 1024 canvas. Asserted rather than
    # assumed: if the art is ever redrawn with a different inset, the crop below
    # would silently clip it.
    $inset = 40
    $minX = 1024; $minY = 1024; $maxX = -1; $maxY = -1
    for ($y = 0; $y -lt 1024; $y++) {
        for ($x = 0; $x -lt 1024; $x++) {
            if ($src.GetPixel($x, $y).A -gt 8) {
                if ($x -lt $minX) { $minX = $x }
                if ($x -gt $maxX) { $maxX = $x }
                if ($y -lt $minY) { $minY = $y }
                if ($y -gt $maxY) { $maxY = $y }
            }
        }
    }
    $seen = @($minX, $minY, (1023 - $maxX), (1023 - $maxY))
    foreach ($edge in $seen) {
        if ([math]::Abs($edge - $inset) -gt 1) {
            throw ("expected a ${inset}px inset on every edge of $Source, measured L=$($seen[0]) " +
                   "T=$($seen[1]) R=$($seen[2]) B=$($seen[3]); the targetsize crop would clip the art")
        }
    }
    $art = New-Object System.Drawing.Rectangle($inset, $inset, (1024 - 2 * $inset), (1024 - 2 * $inset))

    # Draws a source rectangle into a w*h ARGB canvas at the given offset.
    # SourceCopy (not SourceOver) keeps the transparent margin from being
    # blended into a halo; TileFlipXY stops the bicubic kernel sampling
    # off-canvas and ghosting the edges.
    function Write-Png {
        param(
            [System.Drawing.Rectangle]$From,
            [int]$CanvasW, [int]$CanvasH,
            [int]$DestX, [int]$DestY, [int]$DestW, [int]$DestH,
            [string]$Name
        )
        $bmp = New-Object System.Drawing.Bitmap($CanvasW, $CanvasH, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        try {
            $g.Clear([System.Drawing.Color]::Transparent)
            $g.CompositingMode = 'SourceCopy'
            $g.CompositingQuality = 'HighQuality'
            $g.InterpolationMode = 'HighQualityBicubic'
            $g.SmoothingMode = 'HighQuality'
            $g.PixelOffsetMode = 'HighQuality'
            $attr = New-Object System.Drawing.Imaging.ImageAttributes
            try {
                $attr.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
                $dest = New-Object System.Drawing.Rectangle($DestX, $DestY, $DestW, $DestH)
                $g.DrawImage($src, $dest, $From.X, $From.Y, $From.Width, $From.Height,
                             [System.Drawing.GraphicsUnit]::Pixel, $attr)
            } finally { $attr.Dispose() }
        } finally { $g.Dispose() }
        $bmp.Save((Join-Path $OutDir $Name), [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
        [void]$script:emitted.Add($Name)
    }

    $script:emitted = New-Object System.Collections.Generic.List[string]
    $full = New-Object System.Drawing.Rectangle(0, 0, 1024, 1024)

    # --- scale-* families -------------------------------------------------
    # scale-100 is the unqualified filename the manifest points at. WACK
    # requires at least one variant with no targetsize qualifier, so these
    # must keep existing.
    $scales = @(100, 125, 150, 200, 400)
    $square = @{ 'Square44x44Logo' = 44; 'Square150x150Logo' = 150; 'StoreLogo' = 50 }

    # Ceiling, not Round: [math]::Round is banker's rounding, so a 50px logo at
    # 125% lands on 62.5 and rounds DOWN to 62 where Microsoft's asset table
    # says 63. Ceiling matches the table for all four logos at every scale.
    foreach ($name in $square.Keys) {
        $base = $square[$name]
        foreach ($s in $scales) {
            $px = [int][math]::Ceiling($base * $s / 100.0)
            $file = if ($s -eq 100) { "$name.png" } else { "$name.scale-$s.png" }
            Write-Png -From $full -CanvasW $px -CanvasH $px -DestX 0 -DestY 0 -DestW $px -DestH $px -Name $file
        }
    }

    # The wide tile is the same square art centred on a 310x150 canvas.
    foreach ($s in $scales) {
        $w = [int][math]::Ceiling(310 * $s / 100.0)
        $h = [int][math]::Ceiling(150 * $s / 100.0)
        $x = [int][math]::Round(($w - $h) / 2.0)
        $file = if ($s -eq 100) { 'Wide310x150Logo.png' } else { "Wide310x150Logo.scale-$s.png" }
        Write-Png -From $full -CanvasW $w -CanvasH $h -DestX $x -DestY 0 -DestW $h -DestH $h -Name $file
    }

    # --- targetsize-* families --------------------------------------------
    # Microsoft's canonical list. The unplated twins are the whole point of
    # this script; without them Windows plates the icon on every shell surface.
    $targets = @(16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 256)
    $forms = @('', '_altform-unplated', '_altform-lightunplated')

    foreach ($t in $targets) {
        foreach ($form in $forms) {
            Write-Png -From $art -CanvasW $t -CanvasH $t -DestX 0 -DestY 0 -DestW $t -DestH $t `
                      -Name "Square44x44Logo.targetsize-$t$form.png"
        }
    }

    # pack.ps1 copies assets\*.png with a blanket glob, so anything left behind
    # by a renamed target would be packed forever. Sweep what this run did not
    # emit.
    $stale = Get-ChildItem $OutDir -Filter '*.png' -File | Where-Object { $script:emitted -notcontains $_.Name }
    foreach ($f in $stale) {
        Remove-Item $f.FullName -Force
        Write-Output "removed stale asset: $($f.Name)"
    }

    Write-Output "generated $($script:emitted.Count) assets in $OutDir"
} finally {
    $src.Dispose()
}
