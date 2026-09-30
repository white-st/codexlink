$ErrorActionPreference = 'Stop'
# Relay only the signed, same-user desktop's fixed local pipe. Never create a router.
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.IO.Pipes;
using System.Diagnostics;
using System.Security.Principal;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
public static class CodexDesktopPipe {
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetNamedPipeServerProcessId(IntPtr pipe, out uint pid);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    public static string Owner(NamedPipeClientStream pipe) {
        uint pid; if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle.DangerousGetHandle(), out pid)) throw new Exception("owner");
        using (Process process = Process.GetProcessById((int)pid)) {
            if (process.SessionId != Process.GetCurrentProcess().SessionId) throw new Exception("session");
            IntPtr token; if (!OpenProcessToken(process.Handle, 8, out token)) throw new Exception("token");
            try { using (var identity = new WindowsIdentity(token)) {
                if (identity.User != WindowsIdentity.GetCurrent().User) throw new Exception("user");
            }} finally { CloseHandle(token); }
            return process.MainModule.FileName;
        }
    }
    public static void Relay(Stream pipe) {
        var input = Console.OpenStandardInput(); var output = Console.OpenStandardOutput();
        Task.WhenAny(pipe.CopyToAsync(output), input.CopyToAsync(pipe)).GetAwaiter().GetResult();
    }
}
'@
$taskPipe = [IO.Pipes.NamedPipeClientStream]::new('.', 'codex-ipc', [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::Asynchronous)
try {
    # A Node host started from PowerShell 7 can inherit its module search path.
    Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1')
    $taskPipe.Connect(4000)
    $taskExecutable = [CodexDesktopPipe]::Owner($taskPipe)
    if ([IO.Path]::GetFileName($taskExecutable) -notin @('ChatGPT.exe', 'Codex.exe')) { throw 'owner' }
    $taskSignature = Get-AuthenticodeSignature -LiteralPath $taskExecutable
    if ($taskSignature.Status -ne 'Valid' -or $taskSignature.SignerCertificate.Subject -notmatch '(?:^|, )O=(?:"OpenAI OpCo, LLC"|OpenAI OpCo, LLC)(?:, |$)') { throw 'signature' }
    [CodexDesktopPipe]::Relay($taskPipe)
} catch {
    [Console]::Error.WriteLine('DESKTOP_PIPE_UNAVAILABLE')
    exit 1
} finally { $taskPipe.Dispose() }
