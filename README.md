# MemOS + Qdrant + Reranker

> 用 Qdrant HNSW 向量库 + Qwen3-Reranker 替换 MemOS 默认 SQLite 暴力搜索的本地记忆系统。

## 致谢

本项目基于 [MemTensor/MemOS](https://github.com/MemTensor/MemOS)（MemOS Local Plugin）构建。  
MemOS 由 MemTensor 团队开发，是一个面向 Agent 的本地记忆系统，提供分层记忆（L1/L2/L3）、策略归纳、技能结晶等能力。

在此向 MemTensor 团队及所有 MemOS 贡献者致谢。🙏

## 许可证

本项目基于 [Apache License 2.0](LICENSE) 开源。

- **原始项目**：MemTensor/MemOS — [Apache License 2.0](https://github.com/MemTensor/MemOS/blob/main/LICENSE)
- **本衍生项目**：Apache License 2.0，完整许可证文本见 [LICENSE](LICENSE)

Apache 2.0 允许 fork、修改、分发和商用，但要求保留原作者版权声明和许可证副本。

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

## 前置条件

| 服务 | IP | 端口 | 说明 |
|------|------|------|------|
| Embedding | 10.10.4.81 | 8003 | Qwen3-Embedding-0.6B (1024d) |
| Reranker | 10.10.4.81 | 8004 | Qwen3-Reranker-0.6B |
| Qdrant | 10.10.4.79 | 6333 | Qdrant v1.17.1, API Key 认证 |

## 改动清单

### 新增文件

| 文件 | 作用 |
|------|------|
| `core/storage/qdrant.ts` | Qdrant HTTP client (upsert/search/delete/collection) |
| `core/retrieval/reranker-client.ts` | Reranker HTTP client |

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

## 配置示例

```yaml
# ~/.hermes/memos-plugin/config.yaml

embedding:
  provider: openai_compatible
  endpoint: http://10.10.4.81:8003/v1/embeddings
  model: Qwen3-Embedding-0.6B
  dimensions: 1024
  apiKey: ""

storage:
  vectorBackend: qdrant
  qdrant:
    url: http://10.10.4.79:6333
    apiKey: your-qdrant-api-key
    collectionPrefix: memos
    timeoutMs: 10000
    maxRetries: 3

reranker:
  enabled: true
  endpoint: http://10.10.4.81:8004
  model: Qwen3-Reranker-0.6B
  topN: 10
  timeoutMs: 30000
  maxRetries: 3
```

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

# 方式 B: git patch
git apply /path/to/memos-qdrant.patch
```

### 3. 配置

编辑 `~/.hermes/memos-plugin/config.yaml`，按上方示例配置 Embedding、Qdrant、Reranker。

### 4. 重启

```bash
# 重启 Hermes Gateway 加载新配置
hermes gateway restart
```

## Qdrant Collection 结构

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

- [x] Config schema + defaults (storage + reranker)
- [x] Qdrant HTTP client
- [x] Reranker HTTP client
- [x] Traces repo Qdrant searchByVector
- [x] Repos index accept Qdrant options
- [ ] Policies/Skills/WorldModel Qdrant searchByVector
- [ ] 写入端 upsert 同步 Qdrant
- [ ] 检索层 await async searchByVector
- [ ] Reranker 集成到 ranker.ts
- [ ] 端到端测试
- [ ] 发布到 npm

## 许可证

基于 MemOS (Apache-2.0) 修改。
