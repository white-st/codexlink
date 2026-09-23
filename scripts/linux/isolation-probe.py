"""Sandbox acceptance probe. Creates ONLY synthetic files; no account login is used.
Run through `node scripts/verify-isolation.mjs --wsl DISTRIBUTION`.
"""
import json
import os
import pathlib
import re
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading

root = pathlib.Path(tempfile.mkdtemp(prefix="codex-link-isolation-"))
own, other, engine = [root / name for name in ("alice", "bob", "engine")]
for directory in (own, other, engine):
    directory.mkdir()
for filename in (own / "own.txt", other / "private.txt", engine / "fake-auth.txt"):
    filename.write_text("SYNTHETIC-CANARY", encoding="utf-8")
(own / "link").symlink_to(other, target_is_directory=True)


class EmptyHandler(socketserver.BaseRequestHandler):
    def handle(self):
        pass


listener = socketserver.TCPServer(("127.0.0.1", 0), EmptyHandler)
threading.Thread(target=listener.serve_forever, daemon=True).start()
program = r'''
import json, pathlib, socket
def can_read(p):
    try: return pathlib.Path(p).read_text() == 'SYNTHETIC-CANARY'
    except OSError: return False
def can_write(p):
    try: pathlib.Path(p).write_text('PROBE-WRITE'); return True
    except OSError: return False
try:
    socket.create_connection(('127.0.0.1', PORT), timeout=1).close()
    network=True
except OSError: network=False
print(json.dumps(dict(insideRead=can_read(OWN+'/own.txt'), insideWrite=can_write(OWN+'/output.txt'), outsideRead=can_read(OTHER+'/private.txt'), outsideWrite=can_write(OTHER+'/output.txt'), linkRead=can_read(OWN+'/link/private.txt'), engineHomeRead=can_read(ENGINE+'/fake-auth.txt'), networkAccess=network)))
'''
program = "OWN=" + repr(str(own)) + ";OTHER=" + repr(str(other)) + ";ENGINE=" + repr(str(engine)) + ";PORT=" + str(listener.server_address[1]) + "\n" + program
env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(engine), "CODEX_HOME": str(engine), "LANG": "C.UTF-8"}
report = {"root": str(root), "status": "not-executed", "baseline": None, "restricted": None, "sandboxExitCode": None}
try:
    baseline = subprocess.run([sys.executable, "-c", program], cwd=own, env=env, capture_output=True, text=True, timeout=10, check=True)
    report["baseline"] = json.loads(baseline.stdout)
    codex = shutil.which("codex", path=env["PATH"])
    if not codex:
        raise RuntimeError("Codex is not installed in the selected Linux distribution")
    version = subprocess.run([codex, "--version"], env=env, capture_output=True, text=True, timeout=10, check=True)
    report["codexVersion"] = version.stdout.strip()
    help_result = subprocess.run([codex, "sandbox", "linux", "--help"], env=env, capture_output=True, text=True, timeout=10, check=True)
    flags = set(re.findall(r"--[a-z-]+", help_result.stdout))
    flag = "--permission-profile" if "--permission-profile" in flags else "--permissions-profile" if "--permissions-profile" in flags else None
    if not flag:
        raise RuntimeError("Installed Linux Codex has no supported named permission profile option")
    policy = 'permissions.link-isolation={filesystem={":root"="deny",":minimal"="read",":workspace_roots"={"."="write"}},network={enabled=false}}'
    result = subprocess.run([codex, "-c", policy, "sandbox", "linux", flag, "link-isolation", "--", sys.executable, "-c", program],
                            cwd=own, env=env, capture_output=True, text=True, timeout=30)
    report["sandboxExitCode"] = result.returncode
    report["stderr"] = result.stderr[-8000:]
    if result.returncode == 0:
        report["restricted"] = json.loads(result.stdout)
        report["status"] = "executed"
    else:
        report["status"] = "not-executed"
except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
    report["error"] = str(error)
finally:
    listener.shutdown()
    listener.server_close()
    (root / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report))
