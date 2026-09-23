$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskBin = Join-Path $taskRoot '.runtime\bin'
$taskVersion = '2026.9.1'
$taskDigest = '2837888cc0f5d58f15b6dc478376de90b4d3ba5241c7947455d1e0a0df429712'
$taskTarget = Join-Path $taskBin 'cloudflared.exe'
New-Item -ItemType Directory -Path $taskBin -Force | Out-Null
if (!(Test-Path -LiteralPath $taskTarget) -or (Get-FileHash -LiteralPath $taskTarget -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskDigest) {
    $taskDownload = $taskTarget + '.download'
    & curl.exe --fail --location --silent --show-error --connect-timeout 20 --max-time 240 --continue-at - --output $taskDownload "https://github.com/cloudflare/cloudflared/releases/download/$taskVersion/cloudflared-windows-amd64.exe"
    if ($LASTEXITCODE -ne 0) { throw 'The official download did not complete. Its partial file is retained for a later retry.' }
    if ((Get-FileHash -LiteralPath $taskDownload -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskDigest) { throw 'Official release checksum did not match; the downloaded file will not run.' }
    Move-Item -LiteralPath $taskDownload -Destination $taskTarget -Force
}
& $taskTarget --version
