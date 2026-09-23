$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskRuntime = Join-Path $taskRoot '.runtime'
$taskNode = (Get-Command node.exe -ErrorAction Stop).Source
if (-not $env:CODEX_BIN) { $env:CODEX_BIN = (Get-Command codex.exe -ErrorAction Stop).Source }
$env:CODEX_LINK_RUNTIME = $taskRuntime
$env:PORT = '4317'
if (Get-NetTCPConnection -LocalPort 4317 -State Listen -ErrorAction SilentlyContinue) { throw 'Port 4317 is in use. Stop the existing workbench before starting another instance.' }
New-Item -ItemType Directory -Path $taskRuntime -Force | Out-Null
$taskStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$taskStdout = Join-Path $taskRuntime "service-$taskStamp.stdout.log"
$taskStderr = Join-Path $taskRuntime "service-$taskStamp.stderr.log"
$taskProcess = Start-Process -FilePath $taskNode -ArgumentList @('src/server.mjs') -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput $taskStdout -RedirectStandardError $taskStderr -PassThru
$taskDeadline = [DateTime]::UtcNow.AddSeconds(45)
$taskReady = $false
while ([DateTime]::UtcNow -lt $taskDeadline) {
    $taskProcess.Refresh()
    if ($taskProcess.HasExited) { throw "Workbench exited before it was ready. Check $taskStderr" }
    try {
        $taskInfo = Get-Content -LiteralPath (Join-Path $taskRuntime 'server.json') -Raw | ConvertFrom-Json
        if ($taskInfo.pid -eq $taskProcess.Id) {
            $taskResponse = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:4317/api/auth' -TimeoutSec 2
            if ($taskResponse.StatusCode -eq 200 -and ($taskResponse.Content | ConvertFrom-Json).connection.kind -eq 'local') { $taskReady = $true; break }
        }
    } catch { }
    Start-Sleep -Milliseconds 300
}
if (!$taskReady) { throw "Workbench process started but readiness is unconfirmed. Check $taskStdout and $taskStderr" }
[pscustomobject]@{ Pid=$taskProcess.Id; Ready=$true; LocalUrl='http://127.0.0.1:4317'; Stdout=$taskStdout; Stderr=$taskStderr } | ConvertTo-Json
