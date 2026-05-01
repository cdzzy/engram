/**
 * engram/src/semantic_recall.ts
 * 语义检索模块 — Semantic Memory Recall
 *
 * 参考 Rowboat 的"带记忆的 AI 同事" + GitNexus 的知识图谱检索理念，
 * 为 engram 添加基于语义相似度的记忆召回能力。
 * 灵感来源：Rowboat "Open-source AI coworker, with memory"
 */

import { Engram } from "./types";

export interface RecallResult {
  entry: Engram;
  similarity: number; // 0-1 相似度分数
  rank: number;
}

export interface RecallOptions {
  topK?: number;       // 返回前 K 条结果，默认 5
  threshold?: number;   // 相似度阈值，默认 0.6
  decayBoost?: boolean; // 是否启用衰减增强（近期记忆权重更高）
}

/**
 * 语义召回引擎。
 * 使用向量相似度（或轻量级关键词匹配作为后备）检索记忆。
 * 融合了 Rowboat 的"长期记忆"和 engram 自身的时间衰减模型。
 */
export class SemanticRecall {
  private memoryStore: Engram[] = [];
  private embeddingFn?: (text: string) => Promise<number[]>;

  constructor(embeddingFn?: (text: string) => Promise<number[]>) {
    this.embeddingFn = embeddingFn;
  }

  /**
   * 索引记忆条目以支持语义检索。
   * 可以批量索引以提高效率。
   */
  async index(entries: Engram[]): Promise<void> {
    if (this.embeddingFn) {
      // 批量生成嵌入向量
      const texts = entries.map((e) => `${e.content} ${e.tags.join(" ")}`);
      const embeddings = await Promise.all(
        texts.map((t) => this.embeddingFn!(t))
      );
      entries.forEach((entry, i) => {
        entry.embedding = embeddings[i];
      });
    }
    this.memoryStore.push(...entries);
  }

  /**
   * 语义检索：基于查询文本召回相关记忆。
   * 融合了 Rowboat 的记忆排序和 GitNexus 的知识图谱思想。
   */
  async recall(query: string, options: RecallOptions = {}): Promise<RecallResult[]> {
    const { topK = 5, threshold = 0.6, decayBoost = true } = options;
    const results: RecallResult[] = [];

    let queryEmbedding: number[] | null = null;
    if (this.embeddingFn) {
      queryEmbedding = await this.embeddingFn(query);
    }

    for (const entry of this.memoryStore) {
      let score: number;

      if (queryEmbedding && entry.embedding) {
        // 余弦相似度
        score = this._cosineSimilarity(queryEmbedding, entry.embedding);
      } else {
        // 后备：关键词重叠度
        score = this._keywordOverlap(query, entry.content);
      }

      // 应用时间衰减增强（近期记忆优先）
      if (decayBoost) {
        const ageHours = (Date.now() - entry.createdAt) / 3_600_000;
        const decayFactor = Math.exp(-ageHours / 168); // 7天半衰期
        score = score * 0.7 + decayFactor * 0.3;
      }

      if (score >= threshold) {
        results.push({ entry, similarity: score, rank: 0 });
      }
    }

    // 排序并分配排名
    results.sort((a, b) => b.similarity - a.similarity);
    results.forEach((r, i) => (r.rank = i + 1));

    return results.slice(0, topK);
  }

  /**
   * 基于上下文的自适应召回。
   * 根据当前 Agent 状态动态调整召回策略。
   * 参考 Rowboat 的"协作工作流"理念。
   */
  async adaptiveRecall(
    query: string,
    agentContext: {
      currentTask?: string;
      recentMemories?: string[];
    }
  ): Promise<RecallResult[]> {
    const baseResults = await this.recall(query);

    // 如果有近期记忆，增强相关结果
    if (agentContext.recentMemories?.length) {
      const recentIds = new Set(agentContext.recentMemories);
      return baseResults.map((r) => {
        if (recentIds.has(r.entry.id)) {
          return { ...r, similarity: Math.min(1, r.similarity + 0.1) };
        }
        return r;
      }).sort((a, b) => b.similarity - a.similarity);
    }

    return baseResults;
  }

  private _cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0,
      normA = 0,
      normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-8);
  }

  private _keywordOverlap(query: string, content: string): number {
    const qWords = new Set(query.toLowerCase().split(/\W+/).filter(Boolean));
    const cWords = new Set(content.toLowerCase().split(/\W+/).filter(Boolean));
    const intersection = [...qWords].filter((w) => cWords.has(w)).length;
    return intersection / qWords.size;
  }
}

