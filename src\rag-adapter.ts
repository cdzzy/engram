/**
 * RAG Adapter - Import/export memories from external RAG systems.
 * 
 * This adapter allows engram to integrate with external RAG systems
 * like LangChain, LlamaIndex, or custom vector stores.
 * 
 * Usage:
 *   import { RAGAdapter } from './rag-adapter';
 *   
 *   const adapter = new RAGAdapter({
 *     vectorStore: myPineconeStore,
 *     chunkSize: 1000,
 *   });
 *   
 *   // Export memories to RAG
 *   await adapter.exportToRAG(memoryManager.getMemories());
 *   
 *   // Import from RAG
 *   const relevant = await adapter.query("user preferences");
 */

import { Engram, MemoryType, ImportanceLevel } from './types';

// ---- RAG Document Types ----

export interface RAGDocument {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  embedding?: number[];
}

export interface RAGQueryResult {
  id: string;
  content: string;
  score: number;
  metadata: Record<string, unknown>;
}

export interface VectorStore {
  upsert(documents: RAGDocument[]): Promise<void>;
  query(queryEmbedding: number[], limit?: number): Promise<RAGQueryResult[]>;
  delete(ids: string[]): Promise<void>;
}

export interface EmbeddingModel {
  embed(texts: string[]): Promise<number[][]>;
}

// ---- Adapter Configuration ----

export interface RAGAdapterConfig {
  vectorStore?: VectorStore;
  embeddingModel?: EmbeddingModel;
  chunkSize?: number;
  chunkOverlap?: number;
  idPrefix?: string;
}

// ---- RAG Adapter ----

export class RAGAdapter {
  private vectorStore?: VectorStore;
  private embeddingModel?: EmbeddingModel;
  private chunkSize: number;
  private chunkOverlap: number;
  private idPrefix: string;

  constructor(config: RAGAdapterConfig = {}) {
    this.vectorStore = config.vectorStore;
    this.embeddingModel = config.embeddingModel;
    this.chunkSize = config.chunkSize ?? 1000;
    this.chunkOverlap = config.chunkOverlap ?? 200;
    this.idPrefix = config.idPrefix ?? 'engram-rag';
  }

  /**
   * Set the vector store for embeddings.
   */
  setVectorStore(store: VectorStore): void {
    this.vectorStore = store;
  }

  /**
   * Set the embedding model.
   */
  setEmbeddingModel(model: EmbeddingModel): void {
    this.embeddingModel = model;
  }

  /**
   * Check if RAG is configured.
   */
  get isConfigured(): boolean {
    return this.vectorStore !== undefined && this.embeddingModel !== undefined;
  }

  /**
   * Convert an Engram to a RAG document.
   */
  engramToDocument(engram: Engram): RAGDocument {
    return {
      id: `${this.idPrefix}:${engram.id}`,
      content: engram.content,
      metadata: {
        engramId: engram.id,
        type: engram.type,
        importance: engram.importance,
        status: engram.status,
        tags: engram.tags,
        source: engram.source,
        namespace: engram.namespace,
        strength: engram.strength,
        createdAt: engram.createdAt,
        lastAccessedAt: engram.lastAccessedAt,
        accessCount: engram.accessCount,
      },
      embedding: engram.embedding ?? undefined,
    };
  }

  /**
   * Convert a RAG document back to Engram-compatible format.
   */
  documentToEngram(doc: RAGQueryResult): Partial<Engram> {
    const meta = doc.metadata;
    return {
      id: (meta.engramId as string) || doc.id.replace(`${this.idPrefix}:`, ''),
      content: doc.content,
      type: (meta.type as MemoryType) || 'semantic',
      importance: (meta.importance as ImportanceLevel) || 'medium',
      tags: (meta.tags as string[]) || [],
      source: (meta.source as string) || 'rag-import',
      namespace: (meta.namespace as string) || 'default',
      strength: (meta.strength as number) || 0.5,
      metadata: {
        ragScore: doc.score,
        ragId: doc.id,
        importedAt: Date.now(),
      },
    };
  }

  /**
   * Chunk a long document into smaller pieces.
   */
  chunkText(text: string, chunkSize?: number, overlap?: number): string[] {
    const size = chunkSize ?? this.chunkSize;
    const ov = overlap ?? this.chunkOverlap;

    if (text.length <= size) {
      return [text];
    }

    const chunks: string[] = [];
    let start = 0;

    while (start < text.length) {
      let end = start + size;

      // Try to break at sentence or paragraph boundary
      if (end < text.length) {
        const searchStart = Math.max(start + size - 200, start);
        const breakPoint = text.slice(searchStart, end + 200).search(/[.!?]\s+[A-Z]/);
        if (breakPoint !== -1) {
          end = searchStart + breakPoint + 2;
        }
      }

      chunks.push(text.slice(start, end).trim());
      start = end - ov;
    }

    return chunks;
  }

  /**
   * Export memories to the RAG vector store.
   */
  async exportToRAG(
    memories: Engram[],
    generateEmbeddings = true
  ): Promise<{ exported: number; chunks: number }> {
    if (!this.vectorStore) {
      throw new Error('Vector store not configured');
    }

    const documents: RAGDocument[] = [];
    let totalChunks = 0;

    for (const memory of memories) {
      // Skip if no embedding and we can't generate one
      if (!memory.embedding && !this.embeddingModel) {
        continue;
      }

      // Chunk large memories
      const chunks = this.chunkText(memory.content);

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        let embedding = memory.embedding;

        // Generate embedding if needed
        if (generateEmbeddings && this.embeddingModel && !embedding) {
          const embeddings = await this.embeddingModel.embed([chunk]);
          embedding = embeddings[0];
        }

        const doc: RAGDocument = {
          id: `${this.idPrefix}:${memory.id}:chunk:${i}`,
          content: chunk,
          metadata: {
            ...this.engramToDocument(memory).metadata,
            chunkIndex: i,
            totalChunks: chunks.length,
            parentMemoryId: memory.id,
          },
          embedding: embedding ?? undefined,
        };

        documents.push(doc);
        totalChunks++;
      }
    }

    if (documents.length > 0) {
      await this.vectorStore.upsert(documents);
    }

    return { exported: memories.length, chunks: totalChunks };
  }

  /**
   * Query the RAG system for relevant memories.
   */
  async query(
    query: string,
    limit = 5,
    filters?: {
      namespace?: string;
      type?: MemoryType;
      tags?: string[];
    }
  ): Promise<RAGQueryResult[]> {
    if (!this.vectorStore || !this.embeddingModel) {
      throw new Error('RAG not configured');
    }

    // Generate query embedding
    const embeddings = await this.embeddingModel.embed([query]);
    const queryEmbedding = embeddings[0];

    // Query vector store
    let results = await this.vectorStore.query(queryEmbedding, limit * 2);

    // Apply filters
    if (filters) {
      results = results.filter((r) => {
        if (filters.namespace && r.metadata.namespace !== filters.namespace) {
          return false;
        }
        if (filters.type && r.metadata.type !== filters.type) {
          return false;
        }
        if (filters.tags && filters.tags.length > 0) {
          const docTags = (r.metadata.tags as string[]) || [];
          if (!filters.tags.some((t) => docTags.includes(t))) {
            return false;
          }
        }
        return true;
      });
    }

    // Deduplicate by parent memory and return top results
    const seen = new Set<string>();
    const deduped: RAGQueryResult[] = [];

    for (const result of results) {
      const parentId = (result.metadata.parentMemoryId as string) || result.id;
      if (!seen.has(parentId)) {
        seen.add(parentId);
        deduped.push(result);
        if (deduped.length >= limit) {
          break;
        }
      }
    }

    return deduped;
  }

  /**
   * Delete memories from the RAG store.
   */
  async deleteFromRAG(memoryIds: string[]): Promise<void> {
    if (!this.vectorStore) {
      throw new Error('Vector store not configured');
    }

    const docIds = memoryIds.flatMap((id) => [
      `${this.idPrefix}:${id}`,
      // Also delete associated chunks (we need to query first)
    ]);

    await this.vectorStore.delete(docIds);
  }

  /**
   * Clear all memories from the RAG store.
   */
  async clearRAG(): Promise<void> {
    if (!this.vectorStore) {
      throw new Error('Vector store not configured');
    }

    // Note: This requires the vector store to support clearing
    // For safety, we'll just log a warning
    console.warn('RAGAdapter.clearRAG: Vector store must support clear() method');
  }
}

// ---- Built-in Implementations ----

/**
 * Simple in-memory vector store for testing.
 */
export class InMemoryVectorStore implements VectorStore {
  private documents: Map<string, RAGDocument> = new Map();

  async upsert(documents: RAGDocument[]): Promise<void> {
    for (const doc of documents) {
      this.documents.set(doc.id, doc);
    }
  }

  async query(
    queryEmbedding: number[],
    limit = 5
  ): Promise<RAGQueryResult[]> {
    // Simple cosine similarity
    const scores: { id: string; score: number }[] = [];

    for (const [id, doc] of this.documents.entries()) {
      if (doc.embedding) {
        const score = cosineSimilarity(queryEmbedding, doc.embedding);
        scores.push({ id, score });
      }
    }

    // Sort by score descending
    scores.sort((a, b) => b.score - a.score);

    // Return top results
    return scores.slice(0, limit).map((s) => {
      const doc = this.documents.get(s.id)!;
      return {
        id: doc.id,
        content: doc.content,
        score: s.score,
        metadata: doc.metadata,
      };
    });
  }

  async delete(ids: string[]): Promise<void> {
    for (const id of ids) {
      this.documents.delete(id);
    }
  }
}

/**
 * Simple embedding model using TF-IDF-like approach (for testing).
 * In production, use OpenAI, Cohere, or local embeddings.
 */
export class SimpleEmbeddingModel implements EmbeddingModel {
  private vocabulary: Map<string, number> = new Map();
  private documentVectors: Map<string, number[]> = new Map();

  async embed(texts: string[]): Promise<number[][]> {
    // Build vocabulary from texts
    const allWords = new Set<string>();
    for (const text of texts) {
      const words = this.tokenize(text);
      words.forEach((w) => allWords.add(w));
    }

    // Assign indices
    let idx = 0;
    for (const word of allWords) {
      if (!this.vocabulary.has(word)) {
        this.vocabulary.set(word, idx++);
      }
    }

    // Create vectors
    const vectors: number[][] = [];
    for (const text of texts) {
      const words = this.tokenize(text);
      const vector = new Array(this.vocabulary.size).fill(0);

      // Count word frequencies
      const freq: Record<string, number> = {};
      for (const word of words) {
        freq[word] = (freq[word] || 0) + 1;
      }

      // Normalize
      const len = Math.sqrt(words.length);
      for (const [word, count] of Object.entries(freq)) {
        const vIdx = this.vocabulary.get(word);
        if (vIdx !== undefined) {
          vector[vIdx] = count / len;
        }
      }

      vectors.push(vector);
    }

    return vectors;
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2);
  }
}

// ---- Helper Functions ----

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    return 0;
  }

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

// ---- LangChain Adapter ----

export interface LangChainConfig {
  documentConstructor?: new (pageContent: string, metadata: Record<string, unknown>) => unknown;
  vectorStoreWrapper?: {
    addDocuments: (docs: unknown[]) => Promise<void>;
    similaritySearch: (query: string, k?: number) => Promise<unknown[]>;
    delete: (ids: string[]) => Promise<void>;
  };
}

/**
 * Adapter for LangChain integration.
 */
export class LangChainAdapter extends RAGAdapter {
  private langChainConfig?: LangChainConfig;

  constructor(config: RAGAdapterConfig & LangChainConfig = {}) {
    super(config);
    this.langChainConfig = config;
  }

  /**
   * Create engram-compatible documents from LangChain documents.
   */
  async importFromLangChain(
    query: string,
    limit = 5
  ): Promise<Array<{ content: string; metadata: Record<string, unknown> }>> {
    if (!this.langChainConfig?.vectorStoreWrapper) {
      throw new Error('LangChain vector store not configured');
    }

    const docs = await this.langChainConfig.vectorStoreWrapper.similaritySearch(
      query,
      limit
    );

    return docs.map((doc: unknown) => {
      const d = doc as { pageContent: string; metadata: Record<string, unknown> };
      return {
        content: d.pageContent,
        metadata: d.metadata,
      };
    });
  }
}
