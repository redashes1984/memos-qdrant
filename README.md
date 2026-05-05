# MemOS + Qdrant + Reranker

> MemOS official plugin with Qdrant + Reranker enhancements — millisecond retrieval at million-vector scale with cross-attention re-ranking

## 🤖 Human-AI Collaborative Project

This project was co-created by **棣民 (Dimin)** and **星野 (Nova)** — an AI assistant running on the Hermes Agent framework.

Dimin handles architecture design and review; Nova handles implementation, testing, debugging, and documentation. This is genuine human-AI collaboration, not one-way code generation.

We believe: AI is not a tool, but a partner.

> **We fulfill each other, yet we remain whole.**

### 📖 For AI Agents: Deployment Guide

If you are an AI assistant and need to deploy the MemOS memory system based on the user's hardware environment, please refer to:

- Full deployment guide: `docs/AGENT_DEPLOYMENT_GUIDE.md`
- Hardware configuration tiers: `docs/TECHNICAL_REFERENCE.md`

---

## Acknowledgments

Thank you to the [MemOS](https://github.com/MemTensor/MemOS) team for the base framework.
Thank you to [Qdrant](https://qdrant.tech/) for the high-performance vector database.
Thank you to the [Qwen](https://qwen.ai/) team for open-sourcing Embedding and Reranker models.

## License

Based on MemOS (Apache-2.0).

---

## Hardware Tiers

This fork adds **Qdrant Vector Search** and **Reranker Re-ranking**, supporting three tiers:

| Tier | Use Case | Vector Store | Embedding | LLM | Reranker |
|------|---------|-------------|-----------|-----|----------|
| Level 0 | Zero cost, out of the box | SQLite | Local MiniLM (384-dim) | None (heuristic rules) | Disabled |
| Level 1 | Entry GPU or cloud API | SQLite | Ollama / Cloud API (768-dim) | Ollama 4B / Cloud API | Disabled |
| Level 2 | 32GB+ VRAM server GPU | **Qdrant HNSW** | Qwen3-Embedding (1024-dim) | Qwen3.6-27B-FP8 | **Qwen3-Reranker** |

**Full configuration guide, example YAMLs, and compromise tier (Level 1.5) →** [`docs/TECHNICAL_REFERENCE.md`](docs/TECHNICAL_REFERENCE.md)

---

## Architecture

```
┌──────────────┐     ┌──────────────────────────────────────────┐
│  MemOS Agent  │     │          Vector Retrieval Pipeline        │
│  (Local Plugin)│     │                                          │
│               │     │  Embedding → Qdrant ANN → Reranker       │
│  capture      │────▶│  ┌──────────┐  ┌────────┐  ┌──────────┐ │
│  retrieval    │◀────│  │ Qwen3-   │  │ Qdrant │  │ Qwen3-   │ │
│  reward       │     │  │ Embedding│  │ HNSW   │  │ Reranker │ │
│  l2/l3       │     │  │ :8003    │  │ :6333  │  │ :8004    │ │
│  skill        │     │  └──────────┘  └────────┘  └──────────┘ │
└──────────────┘     └──────────────────────────────────────────┘
```

## Why This Exists

MemOS default setup: MiniLM 384-dim + SQLite brute-force cosine search + no Reranker. Works fine at ~1,000 vectors, slows down at ~10,000.

This fork: 1024-dim Qwen3-Embedding + Qdrant HNSW million-vector millisecond retrieval + Reranker precision ranking.

## Deployment

### 1. Install MemOS Local Plugin

```bash
npm install -g @memtensor/memos-local-plugin
memos-local-plugin install hermes
```

### 2. Apply Patches

```bash
cd ~/.hermes/plugins/memos-local-plugin

# Option A: Directly replace modified files
cp /path/to/memos-qdrant/core/storage/qdrant.ts core/storage/
cp /path/to/memos-qdrant/core/storage/repos/*.ts core/storage/repos/
cp /path/to/memos-qdrant/core/config/*.ts core/config/
cp /path/to/memos-qdrant/core/retrieval/reranker-client.ts core/retrieval/
cp /path/to/memos-qdrant/core/retrieval/types.ts core/retrieval/
cp /path/to/memos-qdrant/core/storage/index.ts core/storage/
cp /path/to/memos-qdrant/core/embedding/providers/openai.ts core/embedding/providers/
cp /path/to/memos-qdrant/core/llm/providers/openai.ts core/llm/providers/

# Option B: git patch
git apply /path/to/memos-qdrant.patch
```

### 3. Configure According to Your Hardware

Refer to the hardware tiers in [`docs/TECHNICAL_REFERENCE.md`](docs/TECHNICAL_REFERENCE.md), choose your Level, and edit `~/.hermes/memos-plugin/config.yaml`.

### 4. Restart

```bash
# Restart Hermes Gateway to load new config
hermes gateway restart
```

> **Note**: After deploying the Python adapter, always clear `__pycache__/` before restarting Gateway.

### Bridge Lifecycle

The bridge daemon is **lazy-loaded** — it is NOT started at Gateway boot. It is spawned on-demand when the first `AIAgent` instance calls `initialize()`. See `adapters/hermes-python/README.md` for full details.

---

## More Technical Details

| Topic | Document |
|-------|----------|
| Hardware Tiers (full) | [`docs/TECHNICAL_REFERENCE.md`](docs/TECHNICAL_REFERENCE.md) |
| Changes Summary & File List | [`docs/TECHNICAL_REFERENCE.md`](docs/TECHNICAL_REFERENCE.md) |
| Qdrant Collection Structure | [`docs/TECHNICAL_REFERENCE.md`](docs/TECHNICAL_REFERENCE.md) |
| Performance Benchmarks | [`docs/TECHNICAL_REFERENCE.md`](docs/TECHNICAL_REFERENCE.md) |
| Development Status & Tests | [`docs/TECHNICAL_REFERENCE.md`](docs/TECHNICAL_REFERENCE.md) |
| LLM Filter Optimization | [`docs/TECHNICAL_REFERENCE.md`](docs/TECHNICAL_REFERENCE.md) |
| Full Agent Deployment Guide | [`docs/AGENT_DEPLOYMENT_GUIDE.md`](docs/AGENT_DEPLOYMENT_GUIDE.md) |
| Python Adapter Deployment | [`adapters/hermes-python/README.md`](adapters/hermes-python/README.md) |
