param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$distribution = 'Ubuntu-24.04'

# This is a separate, explicit OS installation step, never called by the app or tests.
Write-Output 'Plan: install WSL and Ubuntu-24.04 using the official Windows installer.'
Write-Output 'Windows administrator elevation and a manual restart may be required.'
Write-Output 'This script does not initialize Codex Link accounts, copy credentials, open network ports, or restart Windows.'
Write-Output 'Command: wsl.exe --install --distribution Ubuntu-24.04 --no-launch'
if (-not $Apply) {
    Write-Output 'Preview only. No system changes were made.'
    return
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Installation requires an elevated PowerShell after approval. No elevation was requested automatically.'
}

$wslPath = (Get-Command wsl.exe -ErrorAction Stop).Source
$existing = & $wslPath --list --quiet 2>$null
$listExitCode = $LASTEXITCODE
if ($listExitCode -eq 0 -and @($existing | ForEach-Object { ($_ -replace "`0", '').Trim() }) -contains $distribution) {
    throw 'Ubuntu-24.04 already exists. Inspect it before choosing an isolated worker environment; this script will not reuse or overwrite it.'
}
if ($listExitCode -ne 0 -and $listExitCode -ne 50) {
    throw "Could not inventory existing distributions (exit $listExitCode). Stop and inspect WSL before installing."
}
& $wslPath --install --distribution $distribution --no-launch
$installExitCode = $LASTEXITCODE
if ($installExitCode -eq 3010) {
    Write-Output 'A manual restart is required. Worker installation and acceptance checks remain pending.'
    exit 3010
}
if ($installExitCode -ne 0) { throw "WSL installer returned $installExitCode. Installation may be partial; inspect it before retrying." }
Write-Output 'The installer returned success. Run the environment check after any requested restart; isolation is not yet verified.'
