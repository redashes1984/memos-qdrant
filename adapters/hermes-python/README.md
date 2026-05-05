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

## Deployment

Copy these three `.py` files to `~/.hermes/profiles/<profile>/plugins/memtensor/` and clear `__pycache__/`:

```bash
cp adapters/hermes-python/*.py ~/.hermes/profiles/nova/plugins/memtensor/
rm -rf ~/.hermes/profiles/nova/plugins/memtensor/__pycache__/
systemctl restart hermes-gateway
```
