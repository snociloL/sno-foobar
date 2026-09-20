# Uploads one image to ImgBB and prints its direct URL to stdout.
# Invoked by foo_discord_rich as the artwork "Upload command".
# Reads the API key from imgbb_key.txt next to this script; logs to imgbb_upload.log.
param([string]$FilePath)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$log = Join-Path $PSScriptRoot 'imgbb_upload.log'
function Log($m) { try { Add-Content -Path $log -Value ("{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) } catch {} }

Log ("invoked; FilePath=[" + $FilePath + "]")
try {
    if (-not $FilePath -or -not (Test-Path -LiteralPath $FilePath)) { Log "ERROR: no valid file path passed"; exit 1 }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $apiKey = (Get-Content -Raw -Path (Join-Path $PSScriptRoot 'imgbb_key.txt')).Trim()

    $uploadPath = $FilePath; $tmp = $null
    try {
        Add-Type -AssemblyName System.Drawing
        $img = [System.Drawing.Image]::FromFile($FilePath)
        $max = 512
        if ($img.Width -gt $max -or $img.Height -gt $max) {
            $scale = [Math]::Min($max / $img.Width, $max / $img.Height)
            $nw = [int]($img.Width * $scale); $nh = [int]($img.Height * $scale)
            $bmp = New-Object System.Drawing.Bitmap $nw, $nh
            $g = [System.Drawing.Graphics]::FromImage($bmp)
            $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $g.DrawImage($img, 0, 0, $nw, $nh); $g.Dispose()
            $tmp = [IO.Path]::Combine([IO.Path]::GetTempPath(), 'drp_' + [Guid]::NewGuid().ToString('N') + '.jpg')
            $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Jpeg); $bmp.Dispose()
            $uploadPath = $tmp
            Log ("resized " + $img.Width + "x" + $img.Height + " -> " + $nw + "x" + $nh)
        }
        $img.Dispose()
    } catch { Log ("resize skipped: " + $_.Exception.Message) }

    $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($uploadPath))
    $resp = Invoke-RestMethod -Uri 'https://api.imgbb.com/1/upload' -Method Post -Body @{ key = $apiKey; image = $b64 }
    if ($tmp) { Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue }
    if ($resp.success -and $resp.data.url) {
        Log ("OK -> " + $resp.data.url)
        [Console]::Out.WriteLine($resp.data.url)
    } else {
        Log ("ERROR: imgbb rejected: " + ($resp | ConvertTo-Json -Compress))
        exit 1
    }
} catch {
    Log ("EXCEPTION: " + $_.Exception.Message)
    exit 1
}
