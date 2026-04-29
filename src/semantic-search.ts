/**
 * Semantic Search Adapter for Engram.
 * 
 * Enables embedding-based semantic search for memories.
 * Supports bring-your-own embeddings (OpenAI, Ollama, Cohere, etc.)
 * 
 * Reference: Inspired by supermemory and Mem0 semantic search patterns.
 */

import { MemoryManager, Engram } from "./engram";
import type { MemoryStore } from "./types";

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  dimensions: number;
  name: string;
}

export interface SemanticSearchOptions {
  limit?: number;
  minScore?: number;
  types?: string[];
  tags?: string[];
  since?: number;
}

// ─── OpenAI Embeddings ────────────────────────────────────────────────────────

export class OpenAIEmbeddings implements EmbeddingProvider {
  dimensions = 1536;
  name = "openai";

  constructor(
    private apiKey: string,
    private model: string = "text-embedding-3-small"
  ) {}

  async embed(text: string): Promise<number[]> {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: this.model, input: text }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI embedding failed: ${response.statusText}`);
    }

    const data = await response.json() as { data: Array<{ embedding: number[] }> };
    return data.data[0].embedding;
  }
}

// ─── Ollama Embeddings ────────────────────────────────────────────────────────

export class OllamaEmbeddings implements EmbeddingProvider {
  dimensions = 768;
  name = "ollama";

  constructor(
    private baseUrl: string = "http://localhost:11434",
    private model: string = "nomic-embed-text"
  ) {}

  async embed(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: text }),
    });

    if (!response.ok) {
      throw new Error(`Ollama embedding failed: ${response.statusText}`);
    }

    const data = await response.json() as { embeddings: number[][] };
    return data.embeddings[0];
  }
}

// ─── Cosine Similarity ────────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

// ─── Semantic Search Adapter ─────────────────────────────────────────────────

export class SemanticSearchAdapter {
  constructor(
    private memory: MemoryManager,
    private embeddings: EmbeddingProvider
  ) {}

  /**
   * Search memories using semantic similarity.
   * Combines vector similarity with Engram's recall signals.
   */
  async search(
    query: string,
    options: SemanticSearchOptions = {}
  ): Promise<Array<{ memory: Engram; score: number; source: string }>> {
    const { limit = 10, minScore = 0.5, types, tags, since } = options;

    const queryEmbedding = await this.embeddings.embed(query);

    const candidates = await this.memory.recall({
      query,
      limit: limit * 3,
      types,
      tags,
    });

    const scored: Array<{ memory: Engram; score: number; source: string }> = [];

    for (const memory of candidates) {
      if (since && memory.createdAt < since) continue;

      const importanceScore = this._importanceToScore(memory.importance);
      const text = this._memoryToText(memory);
      const memoryEmbedding = await this.embeddings.embed(text);
      const semanticScore = cosineSimilarity(queryEmbedding, memoryEmbedding);

      const recallBoost = (memory.metadata as any)?.recallScore ?? 0.5;
      const combinedScore = semanticScore * 0.7 + recallBoost * 0.3 * importanceScore;

      if (combinedScore >= minScore) {
        scored.push({
          memory,
          score: combinedScore,
          source: semanticScore > recallBoost ? "semantic" : "recall",
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  private _importanceToScore(importance: string): number {
    const map: Record<string, number> = {
      critical: 1.0,
      high: 0.8,
      medium: 0.5,
      low: 0.2,
    };
    return map[importance] ?? 0.5;
  }

  private _memoryToText(memory: Engram): string {
    return [memory.content, (memory as any).tags?.join(" "), (memory as any).metadata?.summary]
      .filter(Boolean)
      .join(" | ");
  }
}

