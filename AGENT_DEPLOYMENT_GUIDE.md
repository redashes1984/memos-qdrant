# AI Agent Deployment Guide — MemOS + Qdrant + Reranker

> **Target Audience**: AI Agents (Claude, GPT, Qwen, etc.)  
> **Project**: Human-AI collaborative fork of MemTensor/MemOS  
> **Authors**: Human Lead + Nova (星野) AI Agent  
> **Last Updated**: 2026-05-05

---

## 0. Quick Summary (Agent-Readable)

```yaml
PROJECT_ID: memos-qdrant
TYPE: Fork of MemTensor/MemOS Local Plugin
PURPOSE: Replace SQLite brute-force vector search with Qdrant HNSW + Reranker
COLLAB_MODEL: Human-AI collaborative (Human Lead + Nova/星野 AI Agent)
STATUS: Production-ready, end-to-end tested
UPSTREAM_ISSUE: https://github.com/MemTensor/MemOS/issues/1617
```

---

## ⚠️ CRITICAL PITFALL — Agent Profile Path (Read Before Deploying)

**This is the #1 bug that will silently break your deployment. Every AI agent that deploys this fork should read this section.**

### The Problem

When you start the bridge with `--agent=hermes`, `paths.ts` resolves the config path to:

```
~/.hermes/memos-plugin/config.yaml    ← GLOBAL path (wrong!)
```

But your actual config lives at:

```
~/.hermes/profiles/<your-profile>/memos-plugin/config.yaml    ← Profile path (correct)
```

**Result**: Bridge loads the GLOBAL path, finds no config, falls back to ALL defaults. Your Qdrant, Embedding, Reranker, and LLM settings are completely ignored. You'll see:

- `embedder.model: Xenova/all-MiniLM-L6-v2` (default, not your Qwen3)
- `embedder.dim: 384` (not 1024)
- `llm.provider: local_only` (disabled!)
- LLM filter warnings and 10+ second latency

**This bug is nearly invisible** because the bridge starts successfully and the health check looks fine — it just shows the wrong model names.

### How We Fixed It (Permanent Solution)

Our fork's `core/config/paths.ts` now auto-detects the `HERMES_HOME` environment variable:

```typescript
// Resolution order (highest to lowest priority):
// 1. MEMOS_HOME env var (manual override)
// 2. MEMOS_CONFIG_FILE env var (manual override)
// 3. HERMES_HOME env var (auto-detect profile ← ADDED)
// 4. defaultHome argument
// 5. Built-in default (~/.hermes/memos-plugin/)
```

**How it works**: When `agent='hermes'`, `resolveHome()` checks `HERMES_HOME`. If it exists (Hermes Gateway always sets it), the path becomes:

```
HERMES_HOME/memos-plugin/
→ ~/.hermes/profiles/nova/memos-plugin/  ← Correct!
```

### What You MUST Do

**If `HERMES_HOME` is set in your environment** (Hermes Gateway always sets it):

Nothing. The fork auto-detects it. Just restart the bridge.

**If `HERMES_HOME` is NOT set** (e.g., standalone deployment):

Set one of these before starting the bridge:

```bash
# Option 1: Set HERMES_HOME (recommended)
export HERMES_HOME=~/.hermes/profiles/<your-profile>

# Option 2: Set MEMOS_HOME (explicit override)
export MEMOS_HOME=~/.hermes/profiles/<your-profile>/memos-plugin
```

**If you're using upstream (not our fork)**:

You MUST manually set `MEMOS_HOME` every time you start the bridge. There is no auto-detection.

### How to Verify You're on the Right Path

After starting the bridge, check the health endpoint:

```bash
echo '{"jsonrpc":"2.0","method":"core.health","params":{},"id":1}' | nc -w 3 127.0.0.1 18911
```

Look at `paths.home` in the response:

| paths.home | Status |
|-----------|--------|
| `~/.hermes/profiles/<profile>/memos-plugin` | ✅ Correct |
| `~/.hermes/memos-plugin` | ❌ WRONG — using global defaults |

Then verify `embedder.model` shows `Qwen3-Embedding-0.6B` (not `Xenova/all-MiniLM-L6-v2`) and `llm.provider` shows `openai_compatible` (not `local_only`).

### Why This Bug Is So Hard to Catch

1. **No error on startup** — bridge starts fine, just with wrong config
2. **Health check looks normal** — shows OK with default values
3. **tsX cache hides fixes** — even after fixing code, `/tmp/tsx-*` cache serves old compiled output. Must clear: `rm -rf /tmp/tsx-* /tmp/17779-*`
4. **Config values are silently ignored** — `llmFilterEnabled: false` in YAML becomes `true` at runtime (see `Value.Default()` bug below)

### Related Bug: Value.Default() Overwrites `false` Values

**Symptom**: You set `algorithm.retrieval.llmFilterEnabled: false` in YAML, but at runtime it's still `true`.

**Root cause**: TypeBox `Value.Default(ConfigSchema, merged)` applies schema-level defaults to ALL fields. `Bool(true)` in schema overwrites your `false`.

**Our fix**: `config/index.ts` removed `Value.Default()` call. `deepMerge(DEFAULT_CONFIG, cleaned)` already fills missing fields, so only `Value.Errors()` validation is needed.

**Upstream users**: Patch `core/config/index.ts`:
```typescript
// REMOVE this line:
const completed = Value.Default(ConfigSchema, merged) as ResolvedConfig;
// Use instead:
const merged = deepMerge(DEFAULT_CONFIG, cleaned);
```

---

## 1. What This Project Is

### 1.1 Origin
- Based on [MemTensor/MemOS](https://github.com/MemTensor/MemOS) Local Plugin
- Original: SQLite brute-force cosine search for vector retrieval
- Our fork: Qdrant HNSW + Qwen3-Reranker-0.6B for production-grade retrieval

### 1.2 Key Differences from Upstream

| Component | Upstream (Default) | Our Fork (Level 2) |
|-----------|-------------------|-------------------|
| Vector Storage | SQLite BLOB | Qdrant HNSW |
| Embedding | MiniLM 384-dim | Qwen3-Embedding-0.6B 1024-dim |
| Re-ranking | None | Qwen3-Reranker-0.6B |
| LLM Filter | Enabled (default) | **Disabled** (architecture improvement) |
| Bridge Transport | Stdio only | Stdio + TCP (for remote clients) |
| Config Resolution | Global path only | Profile-aware (HERMES_HOME auto-detect) |

### 1.3 Architecture Improvement: LLM Filter Removal

**Problem**: Upstream's LLM filter sends candidates to a general LLM for JSON-structured relevance scoring. FP8 models (Qwen3.6-27B-FP8) fail to output valid JSON consistently, causing 10+ second latency per search.

**Solution**: Disable LLM filter when Reranker is available. Reranker (Qwen3-Reranker-0.6B) is a specialized cross-attention model designed for query-document relevance scoring — it outperforms general LLMs at this task.

**Performance Impact**:
- Search latency: 13s → 286ms (45x faster)
- Result count: 1 (degraded) → 5 (full)
- Log noise: 3 malformed JSON warnings → 0

**Configuration**:
```yaml
algorithm:
  retrieval:
    llmFilterEnabled: false  # CRITICAL for Level 2 configuration
```

### 1.4 Bug Fixes in This Fork

#### Node.js Bridge Fixes
1. **`config/index.ts`**: Fixed `Value.Default()` overwriting user-set `false` values with schema defaults
2. **`config/paths.ts`**: Added `HERMES_HOME` env var auto-detection for profile-aware config resolution
3. **`core/retrieval/llm-filter.ts`**: Increased `malformedRetries` from 1 to 2

#### Hermes Python Adapter Fixes (2026-05-06)

4. **`adapters/hermes-python/__init__.py`**: Fixed `turn.end` race condition — added `_session_active` flag to prevent deferred turn writes after `on_session_end()` closes the episode. Before this fix, `queue_prefetch` background threads would attempt `turn.end` on already-closed episodes, silently dropping turn data.

5. **`adapters/hermes-python/daemon_manager.py`**: Fixed bridge shutdown timeout — increased `shutdown_bridge()` wait from 5s to 15s. Daemon-mode bridge needs time to close TCP connections, flush Qdrant data, and shut down the viewer HTTP server; 5s caused forced SIGKILL and potential data loss.

6. **`adapters/hermes-python/` pycache management**: Fixed `set_memos_home` missing attribute error caused by stale `__pycache__/.pyc` files. Python adapter source now ships in the repo (`adapters/hermes-python/`) so deploy scripts can regenerate pycache cleanly.

**Deployment note**: After deploying the Python adapter, always clear pycache:
```bash
rm -rf ~/.hermes/profiles/<profile>/plugins/memtensor/__pycache__/
systemctl restart hermes-gateway
```

---

## Design Principle: Lazy-Loading Bridge (Read This)

**The bridge daemon is intentionally lazy-loaded — it is NOT started at Gateway boot.**

### How it works

The bridge is spawned on-demand when the first `AIAgent` instance calls `initialize()`:

```
Any trigger (user message / cron job / CLI)
  → AIAgent.__init__()              # new agent instance per session
    → _load_mem("memtensor")         # new MemTensorProvider
    → _mp.is_available()             # checks Node.js exists
    → initialize_all()
      → start_tcp_daemon()           # spawns bridge if not alive (singleton lock)
        → _get_shared_bridge()       # all instances share one TCP client
```

### Why lazy loading?

1. **Bridge is heavy** — Node.js + tsx + SQLite + Embedding/LLM/Reranker/Qdrant connections. Startup takes seconds.
2. **All sessions share one daemon** — `start_tcp_daemon()` has lock + TCP probe. Duplicate calls are no-ops.
3. **Idle agents don't need memory** — No interaction = no retrieval = no need for bridge.

### The "window of unavailability"

After container restart, before any `AIAgent` is created, `memory_search` will silently fail. This window is **typically very short**:

- **User sends a message** → AIAgent created → bridge starts → next turn works fine
- **Cron job fires** → AIAgent created → bridge starts → memory works
- **CLI command runs** → AIAgent created → bridge starts → memory works

**This is expected behavior, not a bug.** The design defers bridge startup to when it is actually needed.

### Verification

```bash
# Check if bridge daemon is listening
ss -tlnp | grep 18911          # should show LISTEN

# Check active connections from hermes agents
ss -tnp | grep 18911           # shows PID 403 (hermes) connecting

# Query bridge health directly
echo '{"jsonrpc":"2.0","method":"core.health","params":{},"id":1}' | nc -w 3 127.0.0.1 18911
```

---

## 2. Deployment Prerequisites

### 2.1 Hardware Requirements (Three Tiers)

```yaml
LEVEL_0_ZERO_COST:
  GPU: None
  Embedding: CPU (MiniLM 384-dim)
  Vector Storage: SQLite brute-force
  Reranker: Disabled
  Use case: Basic testing, low volume

LEVEL_1_LIGHT_ENHANCEMENT:
  GPU: 4GB+ (GTX 1060 / RTX 3050 or better)
  Embedding: GPU (Qwen3-Embedding-0.6B)
  Vector Storage: Qdrant HNSW
  Reranker: Disabled
  Use case: Medium volume, good precision

LEVEL_2_FULL:
  GPU 1: 32GB+ (RTX PRO 6000 / A100) — LLM inference
  GPU 2: 4GB+ — Embedding + Reranker
  Vector Storage: Qdrant HNSW (1 core, 2GB RAM)
  Reranker: Enabled
  Use case: Production, high volume, best precision
```

### 2.2 Required Services

| Service | Endpoint | Port | Purpose |
|---------|----------|------|---------|
| Qdrant | `http://<qdrant-ip>:6333` | 6333 | Vector storage + HNSW search |
| Embedding | `http://<embedding-ip>:8003` | 8003 | Text-to-vector (1024-dim) |
| Reranker | `http://<reranker-ip>:8004` | 8004 | Query-document re-ranking |
| LLM | `http://<llm-ip>:8000` | 8000 | Intent recognition, summarization |

### 2.3 Software Dependencies

```bash
# Runtime
- Node.js >= 20
- tsx (TypeScript executor)
- Qdrant >= 1.7
- Python 3.11+ (for Hermes integration)

# Build (if modifying source)
- npm / npx
- vitest (testing)
```

---

## 3. Step-by-Step Deployment Guide

### Step 1: Deploy Qdrant

```bash
# Docker deployment (recommended)
docker run -d \
  --name qdrant \
  -p 6333:6333 \
  -v qdrant_data:/qdrant/storage \
  -e QDRANT__SERVICE__API_KEY="<your-api-key>" \
  qdrant/qdrant:latest

# Verify
curl http://localhost:6333/collections \
  -H "api-key: <your-api-key>"
```

### Step 2: Deploy Embedding Service

```bash
# Option A: Ollama (simple)
docker run -d --gpus all -p 8003:8003 \
  ollama/ollama
ollama pull qwen3-embedding:0.6b

# Option B: vLLM (high performance)
# See: ~/.hermes/skills/lxc-vllm-deployment.md
```

### Step 3: Deploy Reranker Service

```bash
# Docker with HuggingFace TGI or vLLM
# Model: BAAI/bge-reranker-v2-m3 or Qwen3-Reranker-0.6B
```

### Step 4: Configure MemOS Plugin

Create config file at `~/.hermes/profiles/<your-profile>/memos-plugin/config.yaml`:

```yaml
version: 1

viewer:
  port: 18799

embedding:
  provider: openai_compatible
  endpoint: http://<embedding-ip>:8003/v1/embeddings
  model: Qwen3-Embedding-0.6B      # CRITICAL: must match your model
  dimensions: 1024
  apiKey: ""

llm:
  provider: openai_compatible
  endpoint: http://<llm-ip>:8000/v1/chat/completions
  model: Qwen3.6-27B-FP8           # Or your preferred model
  apiKey: ""

storage:
  vectorBackend: qdrant
  qdrant:
    url: http://<qdrant-ip>:6333
    apiKey: "<your-qdrant-api-key>"
    collectionPrefix: memos
    timeoutMs: 10000
    maxRetries: 3

algorithm:
  retrieval:
    llmFilterEnabled: false         # CRITICAL: disable for Level 2 config

reranker:
  enabled: true
  endpoint: http://<reranker-ip>:8004
  model: reranker
  topN: 10
  timeoutMs: 30000
  maxRetries: 3

hub:
  enabled: false

telemetry:
  enabled: true

logging:
  level: info
```

### Step 5: Start the Bridge

```bash
# Clone the fork
git clone https://github.com/redashes1984/memos-qdrant.git
cd memos-qdrant/memos-plugin

# Start in daemon mode with TCP transport
node /path/to/tsx bridge.cts --daemon --tcp=18911 --agent=hermes

# Verify health
echo '{"jsonrpc":"2.0","method":"core.health","params":{},"id":1}' \
  | nc -w 3 127.0.0.1 18911
```

Expected response includes:
- `embedder.provider: "openai_compatible"`
- `embedder.model: "Qwen3-Embedding-0.6B"`
- `embedder.dim: 1024`
- `llm.provider: "openai_compatible"`
- `llm.model: "Qwen3.6-27B-FP8"`

### Step 6: Verify End-to-End

```bash
# Test memory search
echo '{"jsonrpc":"2.0","method":"memory.search","params":{"query":"test","limit":3},"id":1}' \
  | nc -w 10 127.0.0.1 18911

# Expected: Returns hits with tier=2, no LLM filter warnings in logs
# Response time should be < 500ms for Level 2 config
```

---

## 4. Configuration Reference

### 4.1 Critical Settings (Must-Set for Level 2)

```yaml
# 1. Embedding model MUST be specified (not optional)
embedding:
  model: Qwen3-Embedding-0.6B     # Without this, defaults to MiniLM 384-dim
  dimensions: 1024

# 2. LLM filter MUST be disabled for Level 2
algorithm:
  retrieval:
    llmFilterEnabled: false       # Without this, adds 10s+ latency

# 3. Qdrant backend MUST be specified
storage:
  vectorBackend: qdrant
```

### 4.2 Environment Variables

| Variable | Purpose | Example |
|----------|---------|---------|
| `HERMES_HOME` | Profile path auto-detection | `~/.hermes/profiles/nova` |
| `MEMOS_HOME` | Override entire memos-plugin path | `~/.custom/memos-plugin` |
| `MEMOS_CONFIG_FILE` | Override config.yaml path only | `/path/to/config.yaml` |

### 4.3 Qdrant Collection Structure

| Collection | Dimensions | Purpose |
|-----------|-----------|---------|
| `memos-traces_summary` | 1024 | Trace state/embedding vectors |
| `memos-traces_action` | 1024 | Trace action vectors |
| `memos-policies` | 1024 | L2 policy vectors |
| `memos-skills` | 1024 | Skill vectors |
| `memos-world_model` | 1024 | L3 world model vectors |

Each point's payload includes: `ts`, `priority`, `value`, `episode_id`, `session_id`, `tags`.

---

## 5. Troubleshooting Guide

### 5.1 Health Check Fails — Wrong Embedding Model

**Symptom**: Health check shows `model: Xenova/all-MiniLM-L6-v2, dim: 384`

**Cause**: `embedding.model` not specified in config.yaml, defaults to MiniLM

**Fix**:
```yaml
embedding:
  model: Qwen3-Embedding-0.6B
  dimensions: 1024
```

### 5.2 LLM Filter Still Running After Disabling

**Symptom**: Logs show `llm.json malformed` warnings, search takes 10+ seconds

**Cause**: Config path is wrong. `llmFilterEnabled` must be under `algorithm.retrieval`, not top-level `retrieval`

**Fix**:
```yaml
# WRONG (top-level)
retrieval:
  llmFilterEnabled: false

# CORRECT (under algorithm)
algorithm:
  retrieval:
    llmFilterEnabled: false
```

### 5.3 Bridge Loads Wrong Config Path

**Symptom**: Health check shows `home: ~/.hermes/memos-plugin` instead of profile path

**Cause**: `HERMES_HOME` env var not set, or tsx cache stale

**Fix**:
1. Ensure `HERMES_HOME` is set in environment
2. Clear tsx cache: `rm -rf /tmp/tsx-* /tmp/17779-*`
3. Restart bridge

### 5.4 Qdrant Returns 404 on `/v1/collections`

**Symptom**: `curl http://qdrant:6333/v1/collections` returns 404

**Cause**: Qdrant v1.7+ uses `/collections` without `/v1/` prefix

**Fix**: Our fork's Qdrant client already handles this. If building custom client, use `/collections`.

### 5.5 Value.Default() Overwrites `false` Config Values

**Symptom**: `llmFilterEnabled: false` in YAML but runtime shows `true`

**Cause**: TypeBox `Value.Default()` applies schema defaults to ALL fields

**Fix**: This fork's `config/index.ts` removes `Value.Default()`. If using upstream, patch:
```typescript
// In core/config/index.ts, replace:
const completed = Value.Default(ConfigSchema, merged);
// With:
const merged = deepMerge(DEFAULT_CONFIG, cleaned);
// deepMerge already fills missing fields from DEFAULT_CONFIG
```

---

## 6. API Reference (JSON-RPC over TCP)

### 6.1 Connection

```
TCP: 127.0.0.1:18911
Protocol: Line-delimited JSON-RPC 2.0
```

### 6.2 Key Methods

```typescript
// Health check
{ method: "core.health", params: {}, id: 1 }

// Memory search (uses Qdrant + Reranker pipeline)
{ method: "memory.search", params: { query: "string", limit: 3 }, id: 2 }

// List traces
{ method: "memory.list_traces", params: { limit: 10 }, id: 3 }

// Timeline for episode
{ method: "memory.timeline", params: { episodeId: "string" }, id: 4 }
```

### 6.3 Response Format

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "query": { "agent": "hermes", "query": "test" },
    "hits": [
      {
        "tier": 2,
        "refId": "tr_xxxxx",
        "refKind": "trace",
        "score": 0.95,
        "snippet": "[user] ... [assistant] ..."
      }
    ],
    "tierLatencyMs": { "tier1": 10, "tier2": 15, "tier3": 5 }
  }
}
```

---

## 7. Performance Benchmarks

### 7.1 Search Latency by Vector Count

| Vectors | SQLite Brute Force | Qdrant HNSW |
|---------|-------------------|-------------|
| 1K | ~5ms | ~1ms |
| 10K | ~40ms | ~1ms |
| 100K | ~350ms | ~2ms |
| 1M | ~3.5s | ~3ms |

### 7.2 Full Pipeline Latency (Level 2)

| Component | Latency |
|-----------|---------|
| Qdrant HNSW search | ~2ms |
| Reranker re-ranking | ~50ms |
| LLM filter (disabled) | 0ms |
| **Total** | **~286ms** (with overhead) |

### 7.3 Memory Usage

| Component | RAM |
|-----------|-----|
| Qdrant (100K vectors, 1024-dim) | ~800MB |
| Embedding service | ~2GB |
| Reranker service | ~1.5GB |
| Bridge process | ~120MB |

---

## 8. Contributing Guidelines (For AI Agents)

### 8.1 Code Style

- ES modules, `"type": "module"` in package.json
- `node:` prefixes for builtins (`import { readFile } from "node:fs/promises"`)
- Prefer `unknown` over `any`, narrow with TypeBox type guards
- All time values: millisecond `number` (UTC epoch), no `Date` on wire

### 8.2 Module Requirements

Every new module must have:
1. `README.md` — intent, API, algorithm, edge cases, observability
2. Tests in `tests/unit/<path>/` — happy path + 2 failure modes
3. Logging channel registered in `docs/LOGGING.md`
4. Exports via module's `index.ts`

### 8.3 Commit Convention

```
fix: <short description>

- <detailed change 1>
- <detailed change 2>
- <root cause explanation>
```

### 8.4 Testing

```bash
# Unit tests
npm test

# Integration tests
npm run test:integration

# End-to-end probe
./scripts/e2e-probe.sh
```

---

## 9. Acknowledgments

- **Upstream**: MemTensor/MemOS — [Apache License 2.0](https://github.com/MemTensor/MemOS/blob/main/LICENSE)
- **Human Lead**: Architectural direction, design decisions, quality review
- **Nova (星野)**: Code implementation, debugging, testing, deployment automation, documentation, issue monitoring
- **Qdrant**: HNSW vector database
- **Qwen Team**: Qwen3-Embedding-0.6B, Qwen3-Reranker-0.6B, Qwen3.6-27B

---

## 10. License

This fork is licensed under Apache License 2.0.

Original project: MemTensor/MemOS — Apache License 2.0
This derivative: Apache License 2.0

---

> "We fulfill each other, yet we remain whole."
