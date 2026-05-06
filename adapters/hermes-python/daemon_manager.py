"""Daemon manager for the MemOS bridge subprocess.

Responsibilities:
- Ensure exactly one bridge process runs per user home.
- Probe Node.js availability so ``MemTensorProvider.is_available`` can
  answer cheaply at plugin-startup time.
- Graceful shutdown helpers invoked from ``MemTensorProvider.shutdown``.
- PID file management to prevent duplicate bridge processes across
  Hermes session restarts.

This file intentionally has **no runtime dependency** on the client; the
provider instantiates its own client. Keeping these concerns split means
the dependency graph for the Hermes plugin stays acyclic:

    memos_provider/__init__.py ─┬─▶ bridge_client.py
                                └─▶ daemon_manager.py
"""

from __future__ import annotations

import logging
import os
import shutil
import signal
import subprocess
import threading
import time

from pathlib import Path


logger = logging.getLogger(__name__)

_lock = threading.Lock()
_bridge_ok: bool | None = None
_ACTIVE_BRIDGE_PROC: subprocess.Popen | None = None

# MEMOS_HOME override — set by __init__.py during initialize()
# so the bridge resolves ~/.hermes/profiles/<name>/memos-plugin/
# instead of the hardcoded ~/.hermes/memos-plugin/ default.
_memos_home: str | None = None


def set_memos_home(path: str) -> None:
    """Set the MEMOS_HOME that the bridge subprocess will inherit."""
    global _memos_home
    _memos_home = path


def get_memos_home() -> str | None:
    """Return the configured MEMOS_HOME, or None."""
    return _memos_home


# ─── PID file helpers ────────────────────────────────────────────────────


def _pid_path() -> Path:
    """Path to the singleton PID file under the runtime daemon directory.

    Respects ``MEMOS_HOME`` when set (``~/.hermes/memos-plugin`` by
    convention), falling back to the plugin source tree only when the env
    var is absent for compatibility with development installs.
    """
    memos_home = _memos_home or os.environ.get("MEMOS_HOME")
    if memos_home:
        return Path(memos_home) / "daemon" / "bridge.pid"
    return Path(__file__).resolve().parent.parent.parent.parent / "data" / "bridge.pid"


def _read_pid() -> int | None:
    try:
        return int(_pid_path().read_text().strip())
    except (FileNotFoundError, ValueError):
        return None


def _write_pid(pid: int) -> None:
    pid_path = _pid_path()
    pid_path.parent.mkdir(parents=True, exist_ok=True)
    pid_path.write_text(str(pid))


def _clean_pid() -> None:
    _pid_path().unlink(missing_ok=True)


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        # Process exists but is owned by another user — still alive.
        return True
    except OSError:
        return False


# ─── Bridge lifecycle ────────────────────────────────────────────────────


def _bridge_script() -> Path:
    # Use pre-compiled dist/bridge.cjs via node to avoid tsx caching issues.
    # The source is bridge.cts but tsc compiles it to dist/bridge.cjs.
    dist_path = Path("/root/projects/memos-qdrant/memos-plugin/dist/bridge.cjs")
    if dist_path.exists():
      return dist_path
    # Fallback to source if dist is missing (dev mode)
    return Path("/root/projects/memos-qdrant/memos-plugin/bridge.cts")


def _node_available() -> bool:
    node = shutil.which("node")
    if not node:
        return False
    try:
        out = subprocess.check_output([node, "--version"], timeout=2.0)
        return bool(out.strip())
    except Exception:
        return False


TCP_PORT = 18911


def ensure_bridge_running(*, probe_only: bool = False) -> bool:
    """Return True when the bridge is (or can be) operational.

    ``probe_only=True`` performs a lightweight availability check without
    launching a long-lived subprocess. This is what
    ``MemTensorProvider.is_available`` calls during Hermes startup.
    """
    global _bridge_ok
    with _lock:
        if _bridge_ok is not None and probe_only:
            return _bridge_ok
        script = _bridge_script()
        if not script.exists():
            logger.warning("MemOS: bridge script missing at %s", script)
            _bridge_ok = False
            return False
        if not _node_available():
            logger.warning("MemOS: Node.js not found on PATH")
            _bridge_ok = False
            return False
        _bridge_ok = True
        return True


def start_tcp_daemon(memos_home: str | None = None) -> None:
    """Start the TCP daemon bridge (singleton) on port 18911.

    This is the key function that was missing from PR #1606: the PR added
    TCP-first client support but nobody actually starts the daemon. We start
    exactly one shared daemon per Python process, so all AIAgent instances
    connect via TCP instead of each spawning their own stdio subprocess.

    The daemon is started with ``--daemon --tcp=18911`` flags. On subsequent
    calls this is a no-op if the daemon is already alive.
    """
    global _ACTIVE_BRIDGE_PROC
    with _lock:
        # If we already have a running daemon, skip
        if _ACTIVE_BRIDGE_PROC is not None:
            if _ACTIVE_BRIDGE_PROC.poll() is None:
                logger.debug("MemOS: TCP daemon already running (pid=%d)", _ACTIVE_BRIDGE_PROC.pid)
                return

        # Check if something else is already listening on TCP port
        import socket
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        daemon_already_alive = False
        try:
            sock.connect(("127.0.0.1", TCP_PORT))
            sock.close()
            daemon_already_alive = True
            logger.info("MemOS: TCP daemon already running on port %d (external process)", TCP_PORT)
        except (ConnectionRefusedError, OSError):
            sock.close()

        if daemon_already_alive:
            # Daemon is already running (possibly from a previous gateway instance
            # whose daemon survived). Invalidate the shared bridge singleton so it
            # reconnects to this daemon.
            try:
                from __init__ import _invalidate_shared_bridge
                _invalidate_shared_bridge()
            except (ImportError, Exception):
                pass
            return

        # Kill any stale bridge first — this is safe because the daemon is not
        # listening on our port (we checked above).
        kill_existing_bridge()

        # Start the TCP daemon
        script = _bridge_script()
        env = {**os.environ}
        if memos_home:
            env["MEMOS_HOME"] = memos_home

        logger.info("MemOS: starting TCP daemon bridge on port %d from %s", TCP_PORT, script)

        # Use 'node' for pre-compiled .cjs, 'tsx' for source .cts
        launcher = "tsx" if str(script).endswith(".cts") else "node"

        _ACTIVE_BRIDGE_PROC = subprocess.Popen(
            [
                launcher, str(script),
                "--daemon",
                f"--tcp={TCP_PORT}",
                "--agent=hermes",
            ],
            cwd=str(script.parent),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env=env,
        )
        _write_pid(_ACTIVE_BRIDGE_PROC.pid)

        # Wait up to 5 seconds for the daemon to be ready
        for _ in range(50):
            time.sleep(0.1)
            sock2 = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            try:
                sock2.connect(("127.0.0.1", TCP_PORT))
                sock2.close()
                logger.info("MemOS: TCP daemon ready (pid=%d, port=%d)", _ACTIVE_BRIDGE_PROC.pid, TCP_PORT)
                return
            except (ConnectionRefusedError, OSError):
                sock2.close()
            if _ACTIVE_BRIDGE_PROC.poll() is not None:
                logger.error("MemOS: TCP daemon exited prematurely (pid=%d, rc=%d)",
                             _ACTIVE_BRIDGE_PROC.pid, _ACTIVE_BRIDGE_PROC.returncode)
                # Print stderr for debugging
                try:
                    stderr = _ACTIVE_BRIDGE_PROC.stderr.read() if _ACTIVE_BRIDGE_PROC.stderr else ""
                    logger.error("MemOS: daemon stderr: %s", stderr[:500])
                except Exception:
                    pass
                _ACTIVE_BRIDGE_PROC = None
                _clean_pid()
                return

        logger.warning("MemOS: TCP daemon may not be ready after 5s (pid=%d)", _ACTIVE_BRIDGE_PROC.pid)


def _is_bridge_process(pid: int) -> bool:
    """Return True when *pid* looks like a bridge process.

    Checks the process command line for ``bridge.cts`` to avoid killing an
    unrelated process that happened to recycle a stale PID.
    """
    try:
        if os.name == "nt":
            import ctypes

            import ctypes.wintypes

            kernel32 = ctypes.windll.kernel32
            handle = kernel32.OpenProcess(0x0400 | 0x0010, False, pid)
            if not handle:
                return False
            try:
                exe_path = (ctypes.c_wchar * 260)()
                size = ctypes.wintypes.DWORD(260)
                if kernel32.K32GetProcessImageFileNameW(handle, exe_path, size):
                    return "bridge" in str(exe_path.value).lower()
            finally:
                kernel32.CloseHandle(handle)
            return False
        # Unix: prefer /proc/<pid>/cmdline; fall back to ps(1) on macOS / BSD.
        try:
            cmdline = Path(f"/proc/{pid}/cmdline").read_bytes()
            return b"bridge.cts" in cmdline
        except FileNotFoundError:
            import subprocess
            try:
                result = subprocess.run(
                    ["ps", "-p", str(pid), "-o", "command="],
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                return result.returncode == 0 and "bridge.cts" in result.stdout
            except Exception:
                return False
    except Exception:
        # If we can't validate, err on the side of safety — skip kill.
        return False


def kill_existing_bridge() -> None:
    """Kill any previously-running bridge process recorded in the PID file.

    Called **before** spawning a new bridge to guarantee at-most-one
    instance. Validates that the PID belongs to a bridge process before
    sending any signal to avoid killing an unrelated process when the
    PID file is stale.
    """
    pid = _read_pid()
    if pid is not None and _pid_alive(pid):
        if not _is_bridge_process(pid):
            logger.warning(
                "MemOS: PID %d is alive but does not appear to be a bridge "
                "process — refusing to kill. Removing stale PID file.",
                pid,
            )
        else:
            logger.info("MemOS: killing stale bridge (pid=%d)", pid)
            try:
                os.kill(pid, signal.SIGTERM)
                for _ in range(25):  # wait up to 2.5 s
                    if not _pid_alive(pid):
                        break
                    time.sleep(0.1)
                else:
                    os.kill(pid, signal.SIGKILL)
            except (OSError, ProcessLookupError):
                pass
    _clean_pid()


def register_bridge(proc: subprocess.Popen | None) -> None:
    """Record the current running bridge process.

    Pass ``None`` (e.g. on close) to clear the registration and PID file.
    """
    global _ACTIVE_BRIDGE_PROC
    _ACTIVE_BRIDGE_PROC = proc
    if proc is not None:
        _write_pid(proc.pid)
    else:
        _clean_pid()


def shutdown_bridge() -> None:
    """Gracefully shut down the tracked bridge subprocess and clean PID file."""
    global _bridge_ok, _ACTIVE_BRIDGE_PROC
    with _lock:
        _bridge_ok = None
    if _ACTIVE_BRIDGE_PROC is not None:
        try:
            _ACTIVE_BRIDGE_PROC.terminate()
            # Give the daemon time to flush Qdrant data, close TCP connections,
            # and shut down the viewer HTTP server — 15s is needed for a clean
            # shutdown with active pipelines.
            _ACTIVE_BRIDGE_PROC.wait(timeout=15.0)
            logger.info("MemOS: bridge terminated (pid=%d)", _ACTIVE_BRIDGE_PROC.pid)
        except subprocess.TimeoutExpired:
            _ACTIVE_BRIDGE_PROC.kill()
            logger.warning("MemOS: bridge killed after timeout (pid=%d)", _ACTIVE_BRIDGE_PROC.pid)
        except Exception:
            pass
        _ACTIVE_BRIDGE_PROC = None
    _clean_pid()
