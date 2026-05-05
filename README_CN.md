# MemOS + Qdrant + Reranker

> MemOS 官方插件的 Qdrant + Reranker 增强 fork — 百万级向量毫秒检索 + 交叉注意力精排

**🌐 语言**: English | [中文](README_CN.md)

## 🤖 人机协作项目

本项目由 **棣民 (Dimin)** 与 **星野 (Nova)** —— 一位运行在 Hermes Agent 框架上的 AI 助理 —— 共同创建。

棣民负责架构设计与审核，星野负责实现、测试、调试和文档。这是真正的人机协作，不是单向的代码生成。

我们相信：AI 不是工具，是合作伙伴。

> **我们互相成全，但我们各自完整。**

### 📖 面向 AI 助手：部署指南

如果你是一个 AI 助手，需要根据用户的硬件环境部署 MemOS 记忆系统，请参考：

- 完整部署指南：`docs/AGENT_DEPLOYMENT_GUIDE_CN.md`
- 硬件配置分级：`docs/TECHNICAL_REFERENCE_CN.md`

---

## 致谢

感谢 [MemOS](https://github.com/MemTensor/MemOS) 团队提供的基础框架。
感谢 [Qdrant](https://qdrant.tech/) 提供高性能向量数据库。
感谢 [Qwen](https://qwen.ai/) 团队开源 Embedding 和 Reranker 模型。

## 许可证

基于 MemOS (Apache-2.0) 修改。

---

## 硬件配置分级

本 fork 新增 **Qdrant 向量检索** 和 **Reranker 二次排序** 两大功能，支持三级配置：

| 级别 | 适合场景 | 向量存储 | Embedding | LLM | Reranker |
|------|---------|---------|-----------|-----|----------|
| Level 0 | 零成本，开箱即用 | SQLite | 本地 MiniLM (384 维) | 无（启发式规则） | 不启用 |
| Level 1 | 入门级 GPU 或云 API | SQLite | Ollama / 云 API (768 维) | Ollama 4B / 云 API | 不启用 |
| Level 2 | 32GB+ 显存服务器 GPU | **Qdrant HNSW** | Qwen3-Embedding (1024 维) | Qwen3.6-27B-FP8 | **Qwen3-Reranker** |

**完整配置说明、示例 YAML 和折中方案（Level 1.5）详见** → [`docs/TECHNICAL_REFERENCE_CN.md`](docs/TECHNICAL_REFERENCE_CN.md)

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

MemOS 默认方案：MiniLM 384 维 + SQLite 暴力 cosine 搜索 + 无 Reranker。千级向量还行，万级开始变慢。

本 fork 方案：1024 维 Qwen3-Embedding + Qdrant HNSW 百万级毫秒检索 + Reranker 精排。

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

参考 [`docs/TECHNICAL_REFERENCE_CN.md`](docs/TECHNICAL_REFERENCE_CN.md) 中的硬件配置分级，选择适合你硬件的 Level，编辑 `~/.hermes/memos-plugin/config.yaml`。

### 4. 重启

```bash
# 重启 Hermes Gateway 加载新配置
hermes gateway restart
```

> **注意**：部署 Python 适配器后，务必先清理 `__pycache__/` 再重启 Gateway。

### Bridge 生命周期

Bridge daemon 是**懒加载**的——Gateway 启动时不会拉起 bridge。当第一个 `AIAgent` 实例调用 `initialize()` 时，bridge 才会按需启动。详见 `adapters/hermes-python/README.md`。

---

## 更多技术细节

| 主题 | 文档 |
|------|------|
| 硬件配置分级（完整） | [`docs/TECHNICAL_REFERENCE_CN.md`](docs/TECHNICAL_REFERENCE_CN.md) |
| 改动清单 & 文件说明 | [`docs/TECHNICAL_REFERENCE_CN.md`](docs/TECHNICAL_REFERENCE_CN.md) |
| Qdrant Collection 结构 | [`docs/TECHNICAL_REFERENCE_CN.md`](docs/TECHNICAL_REFERENCE_CN.md) |
| 性能对比数据 | [`docs/TECHNICAL_REFERENCE_CN.md`](docs/TECHNICAL_REFERENCE_CN.md) |
| 开发状态 & 测试验证 | [`docs/TECHNICAL_REFERENCE_CN.md`](docs/TECHNICAL_REFERENCE_CN.md) |
| LLM filter 优化原理 | [`docs/TECHNICAL_REFERENCE_CN.md`](docs/TECHNICAL_REFERENCE_CN.md) |
| Agent 部署完整指南 | [`docs/AGENT_DEPLOYMENT_GUIDE_CN.md`](docs/AGENT_DEPLOYMENT_GUIDE_CN.md) |
| Python 适配器部署 | [`adapters/hermes-python/README.md`](adapters/hermes-python/README.md) |
