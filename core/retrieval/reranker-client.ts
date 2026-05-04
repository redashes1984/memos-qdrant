/**
 * Reranker client — calls a remote reranking API to re-score candidates
 * after vector retrieval.
 *
 * Compatible with Qwen3-Reranker served via the same OpenAI-compatible
 * format as the embedding service (e.g. FastChat or Xinference).
 *
 * API shape:
 *   POST <endpoint>/v1/rerank
 *   { model, query, documents, top_n }
 *   → { data: [{ index, relevance_score }] }
 *
 * Used in `core/retrieval/ranker.ts` as an optional post-retrieval step.
 */

import { rootLogger } from "../logger/index.js";

const log = rootLogger.child({ channel: "retrieval.reranker" });

// ─── Config ─────────────────────────────────────────────────────────────────

export interface RerankerConfig {
  enabled: boolean;
  endpoint: string;
  model: string;
  topN: number;
  timeoutMs: number;
  maxRetries: number;
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RerankResult {
  index: number;
  relevance_score: number;
}

export interface RerankResponse {
  data?: RerankResult[];
}

// ─── Client ─────────────────────────────────────────────────────────────────

export class RerankerClient {
  private enabled: boolean;
  private endpoint: string;
  private model: string;
  private topN: number;
  private timeoutMs: number;
  private maxRetries: number;

  constructor(config: RerankerConfig) {
    this.enabled = config.enabled;
    this.endpoint = config.endpoint.replace(/\/+$/, "");
    this.model = config.model;
    this.topN = config.topN;
    this.timeoutMs = config.timeoutMs;
    this.maxRetries = config.maxRetries;
  }

  /**
   * Rerank documents given a query.
   *
   * @param query   The retrieval query text.
   * @param documents  Array of document texts to rerank.
   * @param indices    Original indices (e.g. positions in the candidate list).
   * @returns Array of { index, score } sorted by relevance (highest first).
   */
  async rerank(
    query: string,
    documents: string[],
    indices: number[],
  ): Promise<Array<{ index: number; score: number }>> {
    if (!this.enabled || !this.endpoint || documents.length === 0) {
      return indices.map((i) => ({ index: i, score: 0 }));
    }

    const topN = Math.min(this.topN, documents.length);

    let attempt = 0;
    while (true) {
      attempt++;
      const start = Date.now();
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const resp = await fetch(`${this.endpoint}/v1/rerank`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: this.model,
            query,
            documents,
            top_n: topN,
          }),
          signal: ctrl.signal,
        });
        clearTimeout(tid);

        if (!resp.ok) {
          const text = await resp.text().catch(() => "");
          if ((resp.status >= 500 || resp.status === 429) && attempt <= this.maxRetries) {
            log.warn("rerank.retry", { status: resp.status, attempt, body: text.slice(0, 100) });
            await sleep(200 * 2 ** (attempt - 1));
            continue;
          }
          throw new Error(`Reranker HTTP ${resp.status}: ${text.slice(0, 200)}`);
        }

        const data = (await resp.json()) as RerankResponse;
        const results = data.data || [];
        const duration = Date.now() - start;

        log.debug("rerank.ok", {
          count: results.length,
          topScore: results[0]?.relevance_score ?? null,
          durationMs: duration,
        });

        return results.map((r) => ({
          index: indices[r.index],
          score: r.relevance_score,
        }));
      } catch (err) {
        clearTimeout(tid);
        if (err instanceof Error && /timeout|abort/i.test(err.message) && attempt <= this.maxRetries) {
          log.warn("rerank.timeout_retry", { attempt });
          await sleep(200 * 2 ** (attempt - 1));
          continue;
        }
        log.error("rerank.failed", { err: err instanceof Error ? err.message : String(err) });
        // Fallback: return all indices with score 0 (keeps original order via stable sort)
        return indices.map((i) => ({ index: i, score: 0 }));
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
