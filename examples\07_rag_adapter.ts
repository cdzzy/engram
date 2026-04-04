/**
 * Example: RAG Adapter for engram.
 * 
 * This example demonstrates how to use the RAG adapter
 * to integrate engram with external RAG systems.
 * 
 * Inspired by Skill_Seekers RAG pipeline patterns.
 * 
 * Usage:
 *   npx ts-node examples/07_rag_adapter.ts
 */

import {
  RAGAdapter,
  InMemoryVectorStore,
  SimpleEmbeddingModel,
  VectorStore,
  EmbeddingModel,
} from '../src/rag-adapter';
import { createEngram, Engram, MemoryType } from '../src';

// Create sample memories for testing
function createSampleMemories(): Engram[] {
  const now = Date.now();

  return [
    createEngram({
      type: 'episodic' as MemoryType,
      content:
        'User prefers concise responses without bullet points. They like direct answers.',
      importance: 'high',
      tags: ['user-preference', 'style'],
      source: 'user-feedback',
    }),
    createEngram({
      type: 'semantic' as MemoryType,
      content:
        'The user is working on a Python project that involves machine learning and data analysis.',
      importance: 'medium',
      tags: ['project', 'python', 'ml'],
      source: 'conversation',
    }),
    createEngram({
      type: 'episodic' as MemoryType,
      content:
        'User asked about integrating with LangChain for RAG applications. They want to use vector stores.',
      importance: 'high',
      tags: ['tech-interest', 'langchain', 'rag'],
      source: 'conversation',
    }),
    createEngram({
      type: 'procedural' as MemoryType,
      content:
        'When debugging Python code, the user prefers to use print statements first before reaching for a debugger.',
      importance: 'medium',
      tags: ['user-preference', 'debugging', 'python'],
      source: 'observation',
    }),
  ];
}

async function exampleBasicAdapter() {
  console.log('='.repeat(60));
  console.log('Example: Basic RAG Adapter');
  console.log('='.repeat(60));

  // Create adapter with in-memory implementations
  const vectorStore = new InMemoryVectorStore();
  const embeddingModel = new SimpleEmbeddingModel();

  const adapter = new RAGAdapter({
    vectorStore,
    embeddingModel,
    chunkSize: 500,
  });

  console.log('\n1. Adapter Configuration:');
  console.log(`   Configured: ${adapter.isConfigured}`);
  console.log(`   Chunk size: 500`);
  console.log(`   Chunk overlap: 200`);

  // Create and export memories
  const memories = createSampleMemories();

  console.log('\n2. Exporting Memories to RAG:');
  const exportResult = await adapter.exportToRAG(memories);
  console.log(`   Exported ${exportResult.exported} memories`);
  console.log(`   Total chunks: ${exportResult.chunks}`);

  return adapter;
}

async function exampleQuery(adapter: RAGAdapter) {
  console.log('\n' + '='.repeat(60));
  console.log('Example: RAG Query');
  console.log('='.repeat(60));

  // Query for user preferences
  console.log('\n1. Query: "What are the user preferences?"');
  const prefs = await adapter.query('user preferences', 3);
  console.log(`   Found ${prefs.length} results:`);
  prefs.forEach((r, i) => {
    console.log(`   ${i + 1}. [score: ${r.score.toFixed(3)}] ${r.content.slice(0, 60)}...`);
  });

  // Query for tech interests
  console.log('\n2. Query: "What technologies is the user interested in?"');
  const tech = await adapter.query('technologies interested', 3);
  console.log(`   Found ${tech.length} results:`);
  tech.forEach((r, i) => {
    console.log(`   ${i + 1}. [score: ${r.score.toFixed(3)}] ${r.content.slice(0, 60)}...`);
  });
}

async function exampleFilters(adapter: RAGAdapter) {
  console.log('\n' + '='.repeat(60));
  console.log('Example: Query with Filters');
  console.log('='.repeat(60));

  // Query with namespace filter
  console.log('\n1. Query with type filter:');
  const episodic = await adapter.query('user project', 3, {
    type: 'episodic' as MemoryType,
  });
  console.log(`   Found ${episodic.length} episodic memories`);

  // Query with tag filter
  console.log('\n2. Query with tag filter:');
  const python = await adapter.query('preferences', 3, {
    tags: ['python', 'user-preference'],
  });
  console.log(`   Found ${python.length} relevant memories`);
}

async function exampleChunking() {
  console.log('\n' + '='.repeat(60));
  console.log('Example: Text Chunking');
  console.log('='.repeat(60));

  const adapter = new RAGAdapter({ chunkSize: 100, chunkOverlap: 20 });

  const longText = `
    This is a very long piece of text that needs to be chunked into smaller pieces.
    It contains multiple sentences. And even some questions? Let me think about this.
    Another paragraph here with different content. We want to ensure that the chunking
    process respects semantic boundaries where possible. But it's not always perfect.
    Final thoughts here. End of the document.
  `.trim();

  console.log('\n1. Original text length:', longText.length, 'characters');

  const chunks = adapter.chunkText(longText, 100, 20);

  console.log(`\n2. Generated ${chunks.length} chunks:`);
  chunks.forEach((chunk, i) => {
    console.log(`   Chunk ${i + 1} (${chunk.length} chars): "${chunk.slice(0, 50)}..."`);
  });
}

async function exampleCustomVectorStore() {
  console.log('\n' + '='.repeat(60));
  console.log('Example: Custom Vector Store');
  console.log('='.repeat(60));

  // Create a custom vector store
  class CustomPineconeStore implements VectorStore {
    private data: Map<string, { content: string; vector: number[]; meta: Record<string, unknown> }> = new Map();

    async upsert(documents) {
      console.log(`   [Custom Store] Upserting ${documents.length} documents...`);
      for (const doc of documents) {
        this.data.set(doc.id, {
          content: doc.content,
          vector: doc.embedding || [],
          meta: doc.metadata,
        });
      }
    }

    async query(queryEmbedding: number[], limit = 5) {
      // Simulate query
      const results = [];
      for (const [id, data] of this.data.entries()) {
        const score = cosineSim(queryEmbedding, data.vector);
        results.push({ id, content: data.content, score, metadata: data.meta });
      }
      return results.sort((a, b) => b.score - a.score).slice(0, limit);
    }

    async delete(ids: string[]) {
      for (const id of ids) {
        this.data.delete(id);
      }
    }
  }

  // Helper
  function cosineSim(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
  }

  const customStore = new CustomPineconeStore();
  const embeddingModel = new SimpleEmbeddingModel();

  const adapter = new RAGAdapter({
    vectorStore: customStore,
    embeddingModel,
  });

  const memories = createSampleMemories();
  await adapter.exportToRAG(memories);

  console.log('\n1. Querying custom store:');
  const results = await adapter.query('langchain rag', 2);
  console.log(`   Found ${results.length} results`);
}

async function exampleProductionUse() {
  console.log('\n' + '='.repeat(60));
  console.log('Example: Production RAG Setup');
  console.log('='.repeat(60));

  console.log(`
Production Setup Guide:
----------------------

1. Choose a Vector Store:
   - Pinecone: For managed, scalable vector database
   - Weaviate: For open-source with built-in embeddings
   - Qdrant: For high-performance Rust-based store
   - ChromaDB: For simple, local-first development

2. Choose an Embedding Model:
   - OpenAI: text-embedding-3-small (fast, affordable)
   - Cohere: embed-multilingual-v3.0 (multilingual support)
   - Local: sentence-transformers (offline, privacy)

3. Configuration Example:

   import { Pinecone } from '@pinecone-database/pinecone';
   import { OpenAIEmbeddings } from '@langchain/openai';

   const pinecone = new Pinecone();
   const index = pinecone.Index('engram-memory');

   const adapter = new RAGAdapter({
     vectorStore: {
       async upsert(docs) {
         await index.upsert(docs.map(d => ({
           id: d.id,
           values: d.embedding,
           metadata: { content: d.content, ...d.metadata }
         })));
       },
       async query(embedding, limit) {
         const results = await index.query({ vector: embedding, topK: limit, includeMetadata: true });
         return results.matches.map(r => ({
           id: r.id,
           content: r.metadata.content,
           score: r.score,
           metadata: r.metadata
         }));
       }
     },
     embeddingModel: {
       async embed(texts) {
         const embeddings = new OpenAIEmbeddings();
         return embeddings.embedDocuments(texts);
       }
     }
   });
`);
}

async function main() {
  console.log('\n🚀 RAG Adapter Examples\n');

  try {
    const adapter = await exampleBasicAdapter();
    await exampleQuery(adapter);
    await exampleFilters(adapter);
    await exampleChunking();
    await exampleCustomVectorStore();
    await exampleProductionUse();

    console.log('\n' + '='.repeat(60));
    console.log('✅ All RAG Adapter examples completed!');
    console.log('='.repeat(60));
  } catch (error) {
    console.error('Error:', error);
  }
}

main();
