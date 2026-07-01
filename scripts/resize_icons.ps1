param (
    [string]$src = "icon_source.png",
    [string]$outDir = "..\public\icons"
)
Add-Type -AssemblyName System.Drawing

$sizes  = @(16, 48, 128)

$original = [System.Drawing.Image]::FromFile($src)

foreach ($size in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.DrawImage($original, 0, 0, $size, $size)
    $g.Dispose()

    $outPath = Join-Path $outDir "icon$size.png"
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "Saved $outPath"
}

$original.Dispose()
Write-Host "Done."
