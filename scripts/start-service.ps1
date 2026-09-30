param(
    [string]$RuntimeDirectory,
    [ValidateRange(1024, 65535)][int]$Port = 4317,
    [switch]$IndependentHost,
    [string]$NodePath,
    [string]$CodexPath,
    [ValidatePattern('^[a-f0-9]{32}$')][string]$LaunchId,
    [string]$OwnerSid
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskRuntime = if ($RuntimeDirectory) { [IO.Path]::GetFullPath($RuntimeDirectory) } else { Join-Path $taskRoot '.runtime' }
$taskUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { throw "Port $Port is in use. Stop the existing workbench before starting another instance." }
New-Item -ItemType Directory -Path $taskRuntime -Force | Out-Null

if (!$IndependentHost) {
    $taskNode = (Get-Command node.exe -ErrorAction Stop).Source
    $taskCodex = if ($env:CODEX_BIN) { (Get-Item -LiteralPath $env:CODEX_BIN -ErrorAction Stop).FullName } else { (Get-Command codex.exe -ErrorAction Stop).Source }
    $LaunchId = [Guid]::NewGuid().ToString('N')
    $taskReport = Join-Path $taskRuntime "launch-$LaunchId.json"
    $taskShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    # Values are PowerShell single-quoted literals, then UTF-16 encoded; no shell interpolation.
    $taskValues = @($PSCommandPath, $taskRuntime, $taskNode, $taskCodex, $LaunchId, $taskUserSid) | ForEach-Object { "'" + $_.Replace("'", "''") + "'" }
    $taskCommand = '& {0} -IndependentHost -RuntimeDirectory {1} -Port {6} -NodePath {2} -CodexPath {3} -LaunchId {4} -OwnerSid {5}' -f ($taskValues + @($Port))
    $taskEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($taskCommand))
    # WMI creates the host outside the desktop's child-process job. Explicit breakaway
    # also keeps this long-lived service outside the WMI provider's own job quota.
    $taskStartup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0; CreateFlags = [uint32]16777216 }
    $taskCreated = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine = ('"{0}" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand {1}' -f $taskShell, $taskEncoded)
        CurrentDirectory = $taskRoot
        ProcessStartupInformation = $taskStartup
    }
    if ($taskCreated.ReturnValue -ne 0) { throw "Independent startup failed (Windows code $($taskCreated.ReturnValue)); no fallback process was started." }
    $taskDeadline = [DateTime]::UtcNow.AddSeconds(55)
    while ([DateTime]::UtcNow -lt $taskDeadline) {
        if (Test-Path -LiteralPath $taskReport) {
            $taskResult = Get-Content -LiteralPath $taskReport -Raw | ConvertFrom-Json
            if (!$taskResult.Ready) { throw $taskResult.Error }
            $taskResult | ConvertTo-Json
            return
        }
        if (!(Get-Process -Id $taskCreated.ProcessId -ErrorAction SilentlyContinue) -and !(Test-Path -LiteralPath $taskReport)) { throw "Startup host exited without readiness. Check logs in $taskRuntime" }
        Start-Sleep -Milliseconds 300
    }
    throw "Independent process was created but readiness is unconfirmed. Check $taskRuntime before retrying."
}

$taskReport = Join-Path $taskRuntime "launch-$LaunchId.json"
try {
if (!$LaunchId -or !$OwnerSid -or $taskUserSid -ne $OwnerSid) { throw 'The independent host must use the original Windows account.' }
if (!(Test-Path -LiteralPath $NodePath -PathType Leaf) -or !(Test-Path -LiteralPath $CodexPath -PathType Leaf)) { throw 'Node or Codex executable is unavailable.' }
$taskNode = $NodePath
$env:CODEX_BIN = $CodexPath
$env:CODEX_LINK_RUNTIME = $taskRuntime
$env:PORT = [string]$Port
$taskStamp = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + $LaunchId.Substring(0, 8)
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
            $taskRequest = [Net.WebRequest]::Create("http://127.0.0.1:$Port/api/auth")
            $taskRequest.Proxy = $null
            $taskRequest.Timeout = 2000
            $taskResponse = $taskRequest.GetResponse()
            try {
                $taskReader = New-Object IO.StreamReader($taskResponse.GetResponseStream())
                try { $taskAuth = $taskReader.ReadToEnd() | ConvertFrom-Json } finally { $taskReader.Dispose() }
                if ([int]$taskResponse.StatusCode -eq 200 -and $taskAuth.connection.kind -eq 'local') { $taskReady = $true; break }
            } finally { $taskResponse.Close() }
        }
    } catch { }
    Start-Sleep -Milliseconds 300
}
if (!$taskReady) { throw "Workbench process started but readiness is unconfirmed. Check $taskStdout and $taskStderr" }
$taskResult = [pscustomobject]@{ Pid=$taskProcess.Id; Ready=$true; LocalUrl="http://127.0.0.1:$Port"; Stdout=$taskStdout; Stderr=$taskStderr; HostPid=$PID; Independent=$true }
} catch {
    $taskResult = [pscustomobject]@{ Ready=$false; Error=$_.Exception.Message; HostPid=$PID }
}
# Publish the report atomically, without exposing the local control token.
$taskTemporaryReport = $taskReport + '.tmp'
$taskResult | ConvertTo-Json | Set-Content -LiteralPath $taskTemporaryReport -Encoding UTF8
Move-Item -LiteralPath $taskTemporaryReport -Destination $taskReport
