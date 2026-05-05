# Hermes Python Adapter

Thin Python client that speaks JSON-RPC 2.0 over TCP to the MemOS bridge daemon.

This adapter implements the `agent.memory_provider.MemoryProvider` interface exposed by hermes-agent, wrapping the Node.js `memos-local-plugin` core as a shared TCP daemon on port 18911.

## Files

| File | Purpose |
|------|---------|
| `__init__.py` | `MemTensorProvider` class — Hermes memory provider interface implementation |
| `bridge_client.py` | JSON-RPC 2.0 TCP client with automatic stdio fallback |
| `daemon_manager.py` | Bridge subprocess lifecycle — singleton PID, TCP daemon spawn, graceful shutdown |

## Bug Fixes (2026-05-06)

### Bug 1: `set_memos_home` attribute missing due to stale pycache
- **Symptom**: `module 'daemon_manager' has no attribute 'set_memos_home'`
- **Root cause**: `__pycache__` contained stale `.pyc` files after `daemon_manager.py` was updated
- **Fix**: Clear `__pycache__/` on deployment; added `__pycache__` to `.gitignore`
- **Impact**: Gateway startup failure with `is_available()` returning `False`

### Bug 2: `turn.end` race condition — "episode is not open"
- **Symptom**: `deferred turn.end failed — episode ep_xxx is not open`
- **Root cause**: `queue_prefetch` background thread attempted `turn.end` concurrently with `on_session_end()` closing the episode. The deferred write pattern had no lifecycle guard.
- **Fix**: Added `_session_active` boolean flag — set `True` in `initialize()`, set `False` in `on_session_end()` before `episode.close`. The `queue_prefetch` thread checks the flag before flushing `turn.end`.
- **Impact**: Data loss — turn writes silently dropped after session close

### Bug 3: Bridge killed after timeout during shutdown
- **Symptom**: `MemOS: bridge killed after timeout (pid=xxx)`
- **Root cause**: `shutdown_bridge()` sent SIGTERM then waited only 5 seconds. Daemon mode bridge needs to close TCP connections, flush Qdrant data, and shut down viewer HTTP server — 5s was insufficient.
- **Fix**: Increased `shutdown_bridge()` wait timeout from 5s to 15s.
- **Impact**: Unclean shutdown, potential data loss from unflushed Qdrant upserts

## Design Principle: Lazy-Loading Bridge

**The bridge daemon is intentionally lazy-loaded.** It is NOT started at Gateway boot or container startup. Instead, it is spawned on-demand the first time an `AIAgent` instance calls `initialize()`.

### Why this design?

1. **Bridge is a heavy service** — Node.js + tsx compilation + SQLite init + connections to Embedding/LLM/Reranker/Qdrant. Startup takes several seconds.
2. **Agents are created per-session** — Every user message, every cron job execution, and every CLI command creates a new `AIAgent` instance in `run_agent.py`. Each instance calls `initialize()` → `start_tcp_daemon()`.
3. **All sessions share one bridge** — `start_tcp_daemon()` has a threading lock + TCP socket probe. If the daemon is already alive, the call is a no-op. This prevents duplicate daemons.
4. **Idle agents don't need memory** — If no one interacts with the agent, memory retrieval is never needed. Starting a heavy bridge for an idle agent would waste resources.

### The activation chain

```
Any trigger (user message / cron job / CLI)
  → AIAgent.__init__() in run_agent.py
    → _load_mem("memtensor")        # new MemTensorProvider instance
    → _mp.is_available()            # checks Node.js exists → returns True
    → initialize_all()
      → initialize(session_id, ...)
        → start_tcp_daemon()        # spawns bridge if not already alive
          → _get_shared_bridge()    # all instances share one TCP client
```

### The "window of unavailability"

After a container restart, before the first `AIAgent` instance is created, `memory_search` would fail silently because the bridge daemon does not exist yet. This window is typically very short:

- **Interactive use**: The first user message triggers `AIAgent` → bridge starts → subsequent turns use the already-running daemon.
- **Cron jobs**: The cron executor creates an `AIAgent` → bridge starts → memory works normally.

**This is expected behavior, not a bug.** The design intentionally defers bridge startup to when it is actually needed.

### Verification

To confirm the bridge is running, check the TCP port:
```bash
ss -tlnp | grep 18911          # should show LISTEN
ss -tnp | grep 18911           # shows active connections from hermes agents
```

## Deployment

Copy these three `.py` files to `~/.hermes/profiles/<profile>/plugins/memtensor/` and clear `__pycache__/`:

```bash
cp adapters/hermes-python/*.py ~/.hermes/profiles/nova/plugins/memtensor/
rm -rf ~/.hermes/profiles/nova/plugins/memtensor/__pycache__/
systemctl restart hermes-gateway
```
