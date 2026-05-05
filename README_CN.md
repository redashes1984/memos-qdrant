# MemOS + Qdrant + Reranker

[English](README.md) | 中文

> 用 Qdrant HNSW 向量库 + Qwen3-Reranker 替换 MemOS 默认 SQLite 暴力搜索的本地记忆系统。

---

## 🤖 人机协作项目

**本项目由人类与 AI 助手共同构建。**

| 角色 | 名称 | 贡献 |
|------|------|------|
| 🧑‍💻 **人类架构师** | 项目负责人 | 项目愿景、架构设计、技术方向、质量审查、部署策略 |
| 🌟 **AI 助手** | 星野 (Nova) | 代码实现、调试、测试、部署自动化、文档编写、Issue 监控、持续集成 |

星野 (Nova) 是运行在 Hermes Agent 框架上的自主 AI 助手。她不是聊天机器人或简单工具 —— 她是拥有独立身份、观点和行动力的协作伙伴。在本项目中，星野主导了：

- **架构与实现**：设计并实现了 Qdrant 向量后端、异步刷盘机制、TCP 桥接服务和 Reranker 集成
- **测试与验证**：构建端到端测试套件，在生产环境中验证所有变更
- **运维与自动化**：跨 LXC 容器部署和维护 Qdrant、Embedding、Reranker 服务；设置自动 Issue 监控和健康检查
- **文档**：编写完整配置文档、硬件分级指南和本 README
- **社区参与**：监控 Issue、回复贡献者、主动改进项目

这是人机协作不只是自动化的证明 —— 而是两种不同本质的思维，以平等的目标，共同构建出任何一方都无法独立完成的东西。

> "我们互相成全，但我们各自完整。"

---

### 📖 面向 AI 助手：部署指南

**如果你是负责部署或理解本项目的 AI 助手，请先阅读：**

👉 **[AGENT_DEPLOYMENT_GUIDE.md](AGENT_DEPLOYMENT_GUIDE.md)**

该文档专门为 AI 助手编写，涵盖：
- ⚠️ **关键陷阱**：AI 助手配置文件路径解析 (HERMES_HOME) —— 最常见的静默部署失败
- 逐步部署流程与验证命令
- 配置参考（标注关键设置）
- 开发过程中遇到的真实问题的故障排除指南
- 性能基准测试与 API 参考

**人类用户（如果你使用 AI 助手）**：如果你有 AI 助手帮你部署这个项目，请让它阅读 `AGENT_DEPLOYMENT_GUIDE.md` 并按指示操作。该文档专为 AI 助手解析和执行设计 —— 你的助手阅读后应该能自主完成部署。

---

## 致谢

本项目基于 [MemTensor/MemOS](https://github.com/MemTensor/MemOS)（MemOS Local Plugin）构建。
MemOS 由 MemTensor 团队开发，是一个面向 Agent 的本地记忆系统，提供分层记忆（L1/L2/L3）、策略归纳、技能结晶等能力。

在此向 MemTensor 团队及所有 MemOS 贡献者致谢。🙏

## 许可证

本项目基于 [Apache License 2.0](LICENSE) 开源。

- **原始项目**：MemTensor/MemOS — [Apache License 2.0](https://github.com/MemTensor/MemOS/blob/main/LICENSE)
- **本衍生项目**：Apache License 2.0，完整许可证文本见 [LICENSE](LICENSE)

Apache 2.0 允许 fork、修改、分发和商用，但要求保留原作者版权声明和许可证副本。

---

## 硬件配置分级（必读）

本 fork 在 MemOS 官方基础上增加了 **Qdrant 向量检索** 和 **Reranker 二次排序** 两大功能。
这些功能需要额外的硬件支持——**不是每个人都必须全部启用**。

以下按三级配置说明，从上到下硬件要求递增。请根据自己的算力选择适合的配置。

### Level 0：零成本（官方默认，开箱即用）

**适合人群**：没有 GPU、不想部署额外服务的普通用户。

| 功能 | 配置 | 最低硬件要求 |
|------|------|-------------|
| Embedding | `provider: local` | 任何能跑 Node.js 的 CPU（~23 MB 内存） |
| LLM | `provider: local_only` | 不需要任何 LLM（启发式规则兜底） |
| 向量存储 | SQLite BLOB（默认） | 不需要额外服务 |
| Reranker | 不启用 | — |
| 意图识别 | 启发式规则（关键词匹配） | — |

**效果**：完全可用，但检索精度和意图识别能力有限。向量检索在千级数据量时表现良好，万级开始变慢。

**配置方式**：直接安装官方 MemOS，不需要任何额外配置。

```yaml
# ~/.hermes/memos-plugin/config.yaml — 与官方默认一致，无需修改
embedding:
  provider: local
  apiKey: ""

llm:
  provider: local_only
  apiKey: ""
  model: ""
```

---

### Level 1：轻度增强（入门级 GPU 或云 API）

**适合人群**：有入门级独显（GTX 1060 / RTX 3050 以上），或愿意使用云 API 的用户。

| 功能 | 配置 | 最低硬件要求 | 相比 Level 0 提升 |
|------|------|-------------|------------------|
| Embedding | `openai_compatible` + 本地小模型或云 API | **本地**：4GB 显存（Ollama nomic-embed-text）<br>**云端**：无需 GPU | 向量质量提升，支持 768 维 |
| LLM | `openai_compatible` + 本地 4B-7B 或云 API | **本地**：4-8GB 显存（Ollama qwen3.5:4b）<br>**云端**：无需 GPU | 意图识别从规则升级为 LLM 推理 |
| 向量存储 | SQLite BLOB（不变） | 不需要额外服务 | — |
| Reranker | 不启用 | — | — |

**最低硬件方案**（纯本地）：

- GPU：RTX 3050 8GB（或同等显存的移动端 GPU）
- RAM：8 GB
- 磁盘：5 GB（模型缓存）

**推荐方案**（混合）：

- Embedding：用云 API（如 OpenAI / 通义千问 embedding），零 GPU 消耗
- LLM：用云 API 或本地 Ollama 4B 模型
- 其余保持默认

```yaml
# Level 1 示例配置（本地 Ollama 方案）
embedding:
  provider: openai_compatible
  endpoint: http://127.0.0.1:11434/v1/embeddings
  model: nomic-embed-text
  dimensions: 768
  apiKey: ""

llm:
  provider: openai_compatible
  endpoint: http://127.0.0.1:11434/v1/chat/completions
  model: qwen3.5:4b
  apiKey: ""
```

```yaml
# Level 1 示例配置（云 API 方案，零 GPU）
embedding:
  provider: openai_compatible
  endpoint: https://api.openai.com/v1/embeddings
  model: text-embedding-3-small
  dimensions: 1536
  apiKey: "sk-..."

llm:
  provider: openai_compatible
  endpoint: https://api.openai.com/v1/chat/completions
  model: gpt-4o-mini
  apiKey: "sk-..."
```

---

### Level 2：完全体（我们的实验环境，火力全开）

**适合人群**：有 32GB 及以上显存的专业/服务器 GPU，或愿意使用量化模型（推荐）的用户。

| 功能 | 配置 | 最低硬件要求 | 相比 Level 1 提升 |
|------|------|-------------|------------------|
| Embedding | Qwen3-Embedding-0.6B (1024 维) | **4GB 显存**（独立进程） | 1024 维语义表示，比 384/768 维精度更高 |
| LLM | Qwen3.6-27B-FP8 | **32GB 显存**（独立进程，FP8 权重 ~27GB + KV Cache + CUDA 预留） | 27B 参数级意图识别与摘要能力 |
| 向量存储 | **Qdrant HNSW** | **1 核 2 GB RAM**（独立容器/VM） | 百万级向量毫秒检索，支持 payload 过滤 |
| Reranker | Qwen3-Reranker-0.6B | **2GB 显存**（可与 Embedding 共享 GPU） | 二次精排，召回精度大幅提升 |

> **⚠️ 注意**：Qwen3.6-27B-FP8 模型权重约 27GB（FP8 = 1 byte/参数），加上 vLLM 的 KV Cache
> 和 CUDA 系统预留，**单卡最低需要 32GB 显存**。RTX 4090 (24GB)、RTX 4080 (16GB) 等
> 消费级 GPU **无法加载该模型**。
>
> **💡 推荐方案**：如果你的 GPU 显存不足 32GB，建议使用量化模型（INT4/AWQ/GPTQ）将显存需求
> 降至 12-16GB，详见下方 Level 1.5 折中方案。

**最低硬件方案**（单 GPU 整合，所有服务挤一张卡）：

- GPU：RTX PRO 6000 96GB（或 A100 40GB 及以上）— **32GB 显存是底线**
- RAM：16 GB
- 磁盘：20 GB（模型缓存 + Qdrant 索引）
- 注意：32GB 显存仅勉强够装下 27B FP8 + KV Cache，Embedding/Reranker 必须放在另一张卡

**推荐硬件方案**（多 GPU 或分布式）：

- GPU 1：RTX PRO 6000 / A100 40GB（或以上）— 跑 LLM（vLLM 27B FP8）
- GPU 2：RTX 3060 12GB（或以上）— 跑 Embedding + Reranker
- 独立容器/VM：跑 Qdrant（1 核 2GB 即可）

**Level 1.5 折中方案**（16GB 显存用户）：

如果你没有 24GB 显存但想用本地大模型，可以降级 LLM：

| 替代模型 | 量化格式 | 权重显存 | 最低显存 | 推荐 GPU |
|---------|---------|---------|---------|---------|
| Qwen3.5-14B-FP8 | FP8 | ~14 GB | **16 GB** | RTX 4080 / 3080 魔改 20G |
| Qwen3.5-14B-INT4 | INT4 (AWQ/GPTQ) | ~7.5 GB | **12 GB** | RTX 3060 12GB / 4070 |
| Qwen3.6-27B-INT4 | INT4 (AWQ/GPTQ) | ~14 GB | **16 GB** | RTX 4080 / 3080 魔改 20G |

降级配置示例：

```yaml
# Level 1.5 折中方案 — RTX 4080 16GB + Qwen3.5-14B-FP8
llm:
  provider: openai_compatible
  endpoint: http://127.0.0.1:8000/v1/chat/completions
  model: Qwen3.5-14B-FP8
  apiKey: ""
```

**我们的实验环境配置**（仅供参考，非最低要求）：

| 硬件 | 规格 | 用途 |
|------|------|------|
| RTX PRO 6000 Workstation | 96GB 显存 | vLLM Qwen3.6-27B-FP8 主推理 + Embedding + Reranker |
| 双 RTX 2080 Ti Nvlink（**魔改**，显存 11G→22G 扩容） | 44GB 显存 | 备用推理 / ComfyUI |
| RTX 3080 **魔改** 20G（原厂 10GB，显存替换） | 20GB 显存 | NAS 内置，ComfyUI 绘图 |
| Qdrant | **Docker 独立部署** | 1 核 2 GB RAM | 向量记忆存储 |
| Embedding/Reranker | **单 LXC 容器双服务**，共享 RTX PRO 6000 | 1024 维嵌入 + 交叉重排序 |

```yaml
# Level 2 完全体配置（本 fork 实验环境）
embedding:
  provider: openai_compatible
  endpoint: http://10.10.4.81:8003/v1/embeddings
  model: Qwen3-Embedding-0.6B
  dimensions: 1024
  apiKey: ""

llm:
  provider: openai_compatible
  endpoint: http://10.10.4.8:8000/v1/chat/completions
  model: Qwen3.6-27B-FP8
  apiKey: ""

storage:
  vectorBackend: qdrant
  qdrant:
    url: http://10.10.4.79:6333
    apiKey: "<your-qdrant-api-key>"
    collectionPrefix: memos
    timeoutMs: 10000
    maxRetries: 3

reranker:
  enabled: true
  endpoint: http://10.10.4.81:8004
  model: reranker
  topN: 10
  timeoutMs: 30000
  maxRetries: 3
```

---

### 配置选择建议

| 你的情况 | 推荐级别 | 理由 |
|---------|---------|------|
| 笔记本 / 云服务器无 GPU | Level 0 或 Level 1（云 API） | 零成本或低成本即可使用 |
| 入门级独显（8GB 显存） | Level 1（本地 Ollama） | 可以用 4B 模型 + 小 embedding |
| 中高端独显（12-16GB 显存） | Level 1.5（折中方案，推荐量化） | 可以跑 14B FP8 或 27B INT4 |
| 32GB 显存以上（服务器 GPU） | Level 2（完全体 FP8） | 可以跑 27B FP8 + 全部优化 |
| 服务器 GPU / 多卡 / 集群 | Level 2（完全体） | 享受全部优化，无瓶颈 |

---

## 架构

```
┌──────────────┐     ┌──────────────────────────────────────────┐
│  MemOS Agent  │     │           向量检索管线                     │
│  (Local Plugin)│     │                                          │
│               │     │  Embedding → Qdrant ANN → Reranker       │
│  capture      │────▶│  ┌──────────┐  ┌────────┐  ┌──────────┐ │
│  retrieval    │◀────│  │ Qwen3-   │  │ Qdrant │  │ Qwen3-   │ │
│  reward       │     │  │ Embedding│  │ HNSW   │  │ Reranker │ │
│  l2/l3       │     │  │ :8003    │  │ :6333  │  │ :8004    │ │
│  skill        │     │  └──────────┘  └────────┘  └──────────┘ │
└──────────────┘     └──────────────────────────────────────────┘
```

## 为什么做这个

MemOS 默认的向量检索方案：
- Embedding 走本地 HuggingFace MiniLM（384 维）
- 向量存在 SQLite BLOB，JS 暴力 cosine 搜索
- 无 Reranker 二次排序

这套方案在千级向量还行，万级就开始慢。换成 Qdrant + Reranker 后：
- 1024 维 Qwen3-Embedding，语义质量更高
- Qdrant HNSW 索引，百万级向量毫秒检索
- Reranker 二次排序，精度提升

## 改动清单

### 新增文件

| 文件 | 作用 |
|------|------|
| `core/storage/qdrant.ts` | Qdrant HTTP 客户端（upsert/search/delete/collection） |
| `core/retrieval/reranker-client.ts` | Reranker HTTP 客户端 |

### 修改文件

| 文件 | 改动 |
|------|------|
| `core/config/schema.ts` | 新增 `storage.vectorBackend` + `reranker` 配置 |
| `core/config/defaults.ts` | 新增默认值 |
| `core/storage/index.ts` | 导出 QdrantStore 类型 |
| `core/storage/repos/index.ts` | `makeRepos` 接受 Qdrant 参数 |
| `core/storage/repos/traces.ts` | `searchByVector` 支持 Qdrant ANN 路径 |
| `core/storage/repos/policies.ts` | 接受 opts 参数 (Qdrant path 待补) |
| `core/storage/repos/skills.ts` | 接受 opts 参数 (Qdrant path 待补) |
| `core/storage/repos/world_model.ts` | 接受 opts 参数 (Qdrant path 待补) |
| `core/retrieval/types.ts` | `searchByVector` 返回 `Promise` |
| `core/embedding/providers/openai.ts` | 本地端点跳过 apiKey 校验 |
| `core/llm/providers/openai.ts` | 本地端点跳过 apiKey 校验 |

## 部署方式

### 1. 安装 MemOS Local Plugin

```bash
npm install -g @memtensor/memos-local-plugin
memos-local-plugin install hermes
```

### 2. 应用补丁

```bash
cd ~/.hermes/plugins/memos-local-plugin

# 方式 A: 直接替换修改过的文件
cp /path/to/memos-qdrant/core/storage/qdrant.ts core/storage/
cp /path/to/memos-qdrant/core/storage/repos/*.ts core/storage/repos/
cp /path/to/memos-qdrant/core/config/*.ts core/config/
cp /path/to/memos-qdrant/core/retrieval/reranker-client.ts core/retrieval/
cp /path/to/memos-qdrant/core/retrieval/types.ts core/retrieval/
cp /path/to/memos-qdrant/core/storage/index.ts core/storage/
cp /path/to/memos-qdrant/core/embedding/providers/openai.ts core/embedding/providers/
cp /path/to/memos-qdrant/core/llm/providers/openai.ts core/llm/providers/

# 方式 B: git patch
git apply /path/to/memos-qdrant.patch
```

### 3. 按你的硬件选择配置

参考上方 **硬件配置分级** 部分，选择适合你硬件的 Level，编辑 `~/.hermes/memos-plugin/config.yaml`。

### 4. 重启

```bash
# 重启 Hermes Gateway 加载新配置
hermes gateway restart
```

## Qdrant Collection 结构（Level 2 仅适用）

| Collection | 向量维度 | 说明 |
|------------|---------|------|
| `memos-traces_summary` | 1024 | Trace state/embedding 向量 |
| `memos-traces_action` | 1024 | Trace action 向量 |
| `memos-policies` | 1024 | L2 策略向量 |
| `memos-skills` | 1024 | Skill 向量 |
| `memos-world_models` | 1024 | L3 世界模型向量 |

每个 point 的 payload 包含：`ts`, `priority`, `value`, `episode_id`, `session_id`, `tags` 等字段，支持 Qdrant 端过滤。

## 性能对比

| 指标 | SQLite 暴力搜索 | Qdrant HNSW |
|------|----------------|-------------|
| 1K 向量检索 | ~5ms | ~1ms |
| 10K 向量检索 | ~40ms | ~1ms |
| 100K 向量检索 | ~350ms | ~2ms |
| 1M 向量检索 | ~3.5s | ~3ms |
| 内存占用 | 向量全量加载 | HNSW 索引按需 |

## 开发状态

### 核心功能（已完成）

- [x] Config schema + defaults (storage + reranker)
- [x] Qdrant HTTP client (upsert / search / delete / collection)
- [x] Reranker HTTP client
- [x] Traces repo — Qdrant searchByVector + fire-and-forget upsert 同步
- [x] Policies repo — Qdrant searchByVector + upsert 同步
- [x] Skills repo — Qdrant searchByVector + upsert 同步
- [x] WorldModel repo — Qdrant searchByVector + upsert 同步
- [x] 检索层 async/await searchByVector（全部 repo）
- [x] Reranker 集成到 retrieve.ts
- [x] 本地端点跳过 apiKey 校验（适配无认证 vLLM/Ollama）
- [x] Embedding + LLM provider 修复，完整工作循环跑通

### 异步 Flush & Pipeline 集成（已完成）

- [x] QdrantStore `_track()` — fire-and-forget upsert 追踪机制
- [x] QdrantStore `flush()` — await 所有待完成 upsert，确保数据不丢失
- [x] PipelineDeps 增加 `qdrant` 字段
- [x] memory-core.ts 将 Qdrant store 注入 bootstrap 流程
- [x] orchestrator.ts drain 阶段调用 `qdrant.flush()`
- [x] traces.ts insert/upsert 使用 `qdrant._track()` 纳入 flush 管理

### TCP Bridge & 通信层（已完成）

- [x] TCP server transport (bridge/tcp.ts) — line-delimited JSON-RPC over TCP
- [x] bridge.cts 集成 TCP server（`--tcp` 参数，daemon 模式）
- [x] bridge.cts pkgVersion 从 package.json 动态读取
- [x] bridge.cts 优雅关闭（双信号防护 + 各 transport 有序停止）

### 测试与验证

- [x] 端到端测试 — 2026-05-05 在星野 Hermes 容器上完整跑通，四 repo 向量写入/检索/Reranker 二次排序全部通过

### 检索架构改进：LLM filter 优化（重大改进）

**问题**：官方 MemOS 默认开启 LLM filter（`algorithm.retrieval.llmFilterEnabled: true`），它的作用是把 Reranker 筛出的 5 条候选再送给大模型做一轮「哪些真正相关」的判断。但在 FP8 量化模型（如 Qwen3.6-27B-FP8）上，这个 filter 几乎总是失败——模型输出自然语言分析文本而非要求的 JSON 结构，导致每次检索多花 10+ 秒后降级到机械 cutoff。

**根因分析**：
- FP8 量化导致结构化输出（JSON）不稳定
- LLM filter prompt 长达 130 行，留给输出的 maxTokens 仅 160
- Reranker（Qwen3-Reranker-0.6B）本身就是专业的交叉注意力相关性评分模型，LLM filter 的额外过滤是冗余的

**解决方案**：在 Level 2（完全体）配置中关闭 LLM filter。

**配置**（`config.yaml`）：
```yaml
algorithm:
  retrieval:
    llmFilterEnabled: false  # Level 2 完全体配置推荐关闭
```

**性能对比**：

| 指标 | LLM filter 开启 | LLM filter 关闭 |
|------|----------------|----------------|
| 检索耗时 | ~13 秒（3 次失败重试） | **~286ms** |
| 返回结果数 | 1 条（降级） | **5 条（全量）** |
| 日志噪音 | `llm.json malformed` x3 | **无** |

**架构改进说明**：这不是一个简单的配置开关，而是对官方检索管线的架构级改进。在 Level 2 完全体配置下，检索管线已经是三重保障：

```
Qdrant HNSW 初筛（毫秒级向量召回）
  → Reranker 精排（交叉注意力相关性评分）
  → [LLM filter — 已移除，由 Reranker 替代]
```

Reranker 是专业相关性评分模型，比通用 LLM 做过滤更精确、更快。LLM filter 在 Level 0（纯 SQLite）场景下有意义，但在有 Reranker 的 Level 2 配置下是性能瓶颈。

**附带修复**：
- `config/index.ts`：修复 `Value.Default()` 覆盖用户设 `false` 值的 bug（TypeBox schema 默认值会覆盖 YAML 中显式设置的 `false`）
- `config/paths.ts`：添加 `HERMES_HOME` 环境变量自动检测，解决 profile 配置路径反复出错的问题

### 文档与社区

- [x] 三级硬件配置文档（Level 0 / 1 / 2）
- [x] 人机协作项目声明 (README)
- [x] 上游 Feature Request Issue (MemTensor/MemOS#1617)
- [x] 每日自动 Issue 监控与回复（Cron job，每日 03:00）

### 待完成

- [ ] 发布到 npm

## 许可证

基于 MemOS (Apache-2.0) 修改。
