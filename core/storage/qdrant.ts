/**
 * Qdrant vector store client.
 *
 * Replaces the in-DB SQLite brute-force vector search with a remote
 * Qdrant instance for ANN (HNSW) retrieval. Designed as a drop-in
 * replacement that keeps the `searchByVector` return types identical
 * so callers in `core/retrieval/` don't need to change.
 *
 * Data model:
 *   - Each MemOS entity type (traces-summary, traces-action, skills,
 *     policies, world_models) gets its own Qdrant collection.
 *   - Points carry payload fields for tag/value filtering.
 *   - Vector dimension matches `config.embedding.dimensions`.
 *
 * Usage:
 *   const qs = new QdrantStore(config.storage.qdrant, config.embedding.dimensions, log);
 *   await qs.ensureCollection("traces_summary", dims);
 *   await qs.upsert("traces_summary", [{ id, vector, payload }]);
 *   const hits = await qs.search("traces_summary", queryVec, 20, { filter });
 */

import { rootLogger } from "../logger/index.js";
import type { EmbeddingVector } from "../types.js";
import type { VectorHit } from "./vector.js";

const log = rootLogger.child({ channel: "storage.qdrant" });

// ─── Config ─────────────────────────────────────────────────────────────────

export interface QdrantConfig {
  url: string;
  apiKey: string;
  collectionPrefix: string;
  timeoutMs: number;
  maxRetries: number;
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface QdrantPoint {
  id: string;
  vector: number[];
  payload?: Record<string, unknown>;
}

export interface QdrantFilter {
  must?: Array<{
    key?: string;
    match?: { any?: string[]; value?: string | number | boolean };
  } | {
    range?: { key: string; gte?: number; lte?: number };
  }>;
}

export interface QdrantSearchOpts {
  k: number;
  filter?: QdrantFilter;
  withPayload?: boolean;
}

export interface QdrantHit {
  id: string;
  score: number;
  payload?: Record<string, unknown>;
}

// ─── HTTP helpers ───────────────────────────────────────────────────────────

async function qdrantFetch(
  url: string,
  method: string,
  apiKey: string,
  body: unknown,
  timeoutMs: number,
  maxRetries: number,
): Promise<Response> {
  let attempt = 0;
  while (true) {
    attempt++;
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      clearTimeout(tid);
      if (resp.ok || resp.status === 404) return resp;
      // Transient?
      if ((resp.status >= 500 || resp.status === 429) && attempt <= maxRetries) {
        await sleep(200 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100));
        continue;
      }
      const text = await resp.text().catch(() => "");
      throw new Error(`Qdrant HTTP ${resp.status}: ${text.slice(0, 200)}`);
    } catch (err) {
      clearTimeout(tid);
      if (err instanceof Error && /timeout|abort/i.test(err.message) && attempt <= maxRetries) {
        await sleep(200 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100));
        continue;
      }
      throw err;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── QdrantStore ────────────────────────────────────────────────────────────

/**
 * Qdrant point IDs must be unsigned integers or UUIDs.
 * MemOS IDs (tr_xxx, sk_xxx, ep_xxx) are opaque strings.
 *
 * We hash string IDs to uint64 for Qdrant storage, and keep the
 * original MemOS ID in payload._id so search results can map back.
 */
function stringHashU64(str: string): number {
  // FNV-1a 64-bit hash, clamped to JS safe integer range.
  const SEED1 = 0x811c9dc5, SEED2 = 0x01000193;
  let s1 = SEED1, s2 = SEED2;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    s1 = Math.imul(s1 ^ c, 0x01000193);
    s2 = Math.imul(s2 ^ c, 0x85ebca6b);
  }
  s1 ^= s1 >>> 16; s1 = Math.imul(s1, 0x21f0aaad); s1 ^= s1 >>> 15;
  s2 ^= s2 >>> 16; s2 = Math.imul(s2, 0x735a2d97); s2 ^= s2 >>> 15;
  // Combine into a positive JS-safe integer (< 2^53)
  return ((s1 >>> 0) + ((s2 >>> 0) % 0x20000000)) >>> 0;
}

/** Check if a string is already a valid Qdrant ID (uint or UUID). */
function isValidQdrantId(id: string): boolean {
  // UUID pattern
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return true;
  // Unsigned integer
  if (/^\d+$/.test(id) && Number(id) >= 0 && Number(id) <= Number.MAX_SAFE_INTEGER) return true;
  return false;
}

/** Convert MemOS string ID to Qdrant-compatible numeric ID. */
function toQdrantId(id: string): number {
  if (isValidQdrantId(id)) return Number(id);
  return stringHashU64(id);
}

export class QdrantStore {
  private baseUrl: string;
  private apiKey: string;
  private prefix: string;
  private timeoutMs: number;
  private maxRetries: number;
  private dims: number;

  constructor(config: QdrantConfig, dims: number) {
    this.baseUrl = config.url.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.prefix = config.collectionPrefix.replace(/-+$/, "");
    this.timeoutMs = config.timeoutMs;
    this.maxRetries = config.maxRetries;
    this.dims = dims;
  }

  /** Full collection name for a given suffix. */
  collectionName(suffix: string): string {
    return `${this.prefix}-${suffix}`;
  }

  /** Ensure collection exists; create with HNSW + Cosine if needed. */
  async ensureCollection(suffix: string): Promise<void> {
    const name = this.collectionName(suffix);
    const url = `${this.baseUrl}/collections/${name}`;

    // Check if exists
    const resp = await qdrantFetch(url, "GET", this.apiKey, null, this.timeoutMs, 0);
    if (resp.status === 200) {
      log.debug("collection.exists", { collection: name });
      return;
    }

    // Create
    log.info("collection.create", { collection: name, dims: this.dims });
    const createResp = await qdrantFetch(url, "PUT", this.apiKey, {
      vectors: { size: this.dims, distance: "Cosine" },
      hnsw_config: { m: 16, ef_construct: 100 },
      optimizers_config: { default_segment_number: 0 },
    }, this.timeoutMs, this.maxRetries);
    if (!createResp.ok) {
      const text = await createResp.text().catch(() => "");
      throw new Error(`Failed to create Qdrant collection ${name}: ${text.slice(0, 200)}`);
    }
  }

  /** Upsert points into a collection. */
  async upsert(
    suffix: string,
    points: QdrantPoint[],
  ): Promise<void> {
    if (points.length === 0) return;
    const name = this.collectionName(suffix);
    const url = `${this.baseUrl}/collections/${name}/points?wait=true`;

    await qdrantFetch(url, "PUT", this.apiKey, {
      points: points.map((p) => ({
        id: toQdrantId(p.id),
        vector: p.vector,
        payload: { _id: p.id, ...(p.payload || {}) },
      })),
    }, this.timeoutMs, this.maxRetries);

    log.debug("upsert", { collection: name, count: points.length });
  }

  /**
   * Ensure the collection exists, then upsert a single point.
   * Convenience method for write-side sync (fire-and-forget from repos).
   */
  async upsertSync(
    suffix: string,
    point: QdrantPoint,
  ): Promise<void> {
    const name = this.collectionName(suffix);
    const url = `${this.baseUrl}/collections/${name}`;

    // Lazy-create collection if missing
    const resp = await qdrantFetch(url, "GET", this.apiKey, null, this.timeoutMs, 0);
    if (resp.status !== 200) {
      log.info("collection.create (lazy)", { collection: name, dims: this.dims });
      await qdrantFetch(url, "PUT", this.apiKey, {
        vectors: { size: this.dims, distance: "Cosine" },
        hnsw_config: { m: 16, ef_construct: 100 },
        optimizers_config: { default_segment_number: 0 },
      }, this.timeoutMs, this.maxRetries);
    }

    // Upsert the point
    await this.upsert(suffix, [point]);
  }

  /** Delete points by ID from a collection. */
  async delete(
    suffix: string,
    ids: string[],
  ): Promise<void> {
    if (ids.length === 0) return;
    const name = this.collectionName(suffix);
    const url = `${this.baseUrl}/collections/${name}/points/delete?wait=true`;

    await qdrantFetch(url, "POST", this.apiKey, {
      points: ids.map(id => toQdrantId(id)),
    }, this.timeoutMs, this.maxRetries);

    log.debug("delete", { collection: name, count: ids.length });
  }

  /**
   * Search by vector similarity.
   *
   * Returns results in the same shape as SQLite-based `scanAndTopK` so
   * callers in `core/retrieval/` work without changes.
   */
  async search(
    suffix: string,
    query: number[],
    opts: QdrantSearchOpts,
  ): Promise<QdrantHit[]> {
    const { k, filter, withPayload = true } = opts;
    const name = this.collectionName(suffix);
    const url = `${this.baseUrl}/collections/${name}/points/search`;

    const body: Record<string, unknown> = {
      vector: query,
      limit: k,
      with_payload: withPayload,
    };
    if (filter && filter.must && filter.must.length > 0) {
      body.filter = filter;
    }

    const resp = await qdrantFetch(url, "POST", this.apiKey, body, this.timeoutMs, this.maxRetries);
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Qdrant search failed for ${name}: ${text.slice(0, 200)}`);
    }

    const data = (await resp.json()) as { result?: Array<{ id: string; score: number; payload?: Record<string, unknown> }> };
    const results = data.result || [];

    log.debug("search", {
      collection: name,
      hits: results.length,
      topScore: results[0]?.score ?? null,
    });

    return results.map((r) => {
      // Restore original MemOS ID from payload._id (we hashed it for Qdrant)
      const originalId = r.payload?._id;
      return {
        id: originalId !== undefined ? String(originalId) : String(r.id),
        score: r.score,
        payload: r.payload || {},
      };
    });
  }

  /**
   * Convert Qdrant hits to the VectorHit shape expected by the retrieval layer.
   *
   * The retrieval code expects `VectorHit<string, TMeta>` with `id`, `score`,
   * and `meta` (which gets populated from the hit payload).
   */
  toVectorHits<TMeta = Record<string, unknown>>(
    hits: QdrantHit[],
  ): Array<VectorHit<string, TMeta>> {
    return hits.map((h) => ({
      id: h.id,
      score: h.score,
      meta: h.payload as TMeta,
    }));
  }
}
