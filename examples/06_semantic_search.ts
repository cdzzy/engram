/**
 * Engram Semantic Search Example.
 * 
 * Demonstrates semantic search with embedding-based memory retrieval.
 * 
 * Usage:
 *   npx ts-node examples/06_semantic_search.ts
 * 
 * Requirements:
 *   - Ollama running locally: ollama serve
 *   - Or OpenAI API key set as OPENAI_API_KEY
 */

import { MemoryManager, createEngram } from '../src/index';
import {
  SemanticSearchAdapter,
  OpenAIEmbeddings,
  OllamaEmbeddings,
} from '../src/semantic-search';

// ─── Mock embeddings for demo (no API key needed) ───────────────────────────

class MockEmbeddings {
  dimensions = 384;
  name = "mock";

  async embed(text: string): Promise<number[]> {
    // Generate a deterministic pseudo-embedding based on text hash
    const hash = this._hashString(text);
    const embedding = new Array(this.dimensions).fill(0);
    for (let i = 0; i < this.dimensions; i++) {
      embedding[i] = Math.sin(hash * (i + 1) * 0.1) * 0.5;
    }
    // Normalize
    const norm = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0));
    return embedding.map(v => v / norm);
  }

  private _hashString(s: string): number {
    let hash = 0;
    for (let i = 0; i < s.length; i++) {
      hash = (hash * 31 + s.charCodeAt(i)) | 0;
    }
    return hash;
  }
}

// ─── Demo ─────────────────────────────────────────────────────────────────────

async function demo_semantic_search() {
  console.log("=" + "=".repeat(59));
  console.log(" Engram Semantic Search Demo");
  console.log("=".repeat(60) + "\n");

  const memory = new MemoryManager({ agentId: 'demo-agent' });

  // Store diverse memories
  const memories = [
    {
      type: 'semantic' as const,
      content: 'User prefers concise responses without bullet points',
      importance: 'high' as const,
      tags: ['user-preference', 'writing-style'],
    },
    {
      type: 'semantic' as const,
      content: 'User works as a Python backend developer at a startup',
      importance: 'high' as const,
      tags: ['user-background', 'profession'],
    },
    {
      type: 'episodic' as const,
      content: 'User asked me to help configure a GitHub Actions CI pipeline today',
      importance: 'medium' as const,
      tags: ['project', 'ci-cd'],
    },
    {
      type: 'semantic' as const,
      content: 'User is interested in AI agents, LLM applications, and automation',
      importance: 'medium' as const,
      tags: ['interests', 'ai'],
    },
    {
      type: 'procedural' as const,
      content: 'When the user says "publish", I should run the build and deploy scripts',
      importance: 'high' as const,
      tags: ['procedure', 'workflow'],
    },
  ];

  console.log("Storing memories...\n");
  for (const mem of memories) {
    await memory.store(createEngram(mem));
    console.log(`  ✓ Stored: ${mem.content.substring(0, 50)}...`);
  }

  // Create semantic search adapter with mock embeddings
  const embeddings = new MockEmbeddings();
  const searcher = new SemanticSearchAdapter(memory, embeddings);

  // Run semantic searches
  const queries = [
    "How should I format my responses?",
    "What is the user's profession?",
    "What should I do when the user says publish?",
    "Is the user interested in AI?",
  ];

  console.log("\n" + "=".repeat(60));
  console.log(" Semantic Search Results");
  console.log("=".repeat(60));

  for (const query of queries) {
    console.log(`\nQuery: "${query}"\n`);
    
    const results = await searcher.search(query, { limit: 3, minScore: 0.1 });
    
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      console.log(`  ${i + 1}. [${r.memory.type}] [score: ${r.score.toFixed(3)}] [${r.source}]`);
      console.log(`     ${r.memory.content}`);
      if (r.memory.tags?.length) {
        console.log(`     Tags: ${r.memory.tags.join(', ')}`);
      }
    }
    
    if (results.length === 0) {
      console.log("  (No results above threshold)");
    }
  }
}

async function demo_with_ollama() {
  console.log("\n" + "=".repeat(60));
  console.log(" With Ollama Embeddings (requires local Ollama)");
  console.log("=".repeat(60));

  const memory = new MemoryManager({ agentId: 'demo-agent' });
  
  try {
    const embeddings = new OllamaEmbeddings(
      "http://localhost:11434",
      "nomic-embed-text"
    );
    const searcher = new SemanticSearchAdapter(memory, embeddings);
    
    await memory.store(createEngram({
      type: 'semantic',
      content: 'User prefers morning meetings',
      importance: 'high',
      tags: ['preference'],
    }));

    const results = await searcher.search("When does the user like meetings?", { limit: 1 });
    console.log(`\nSemantic search result: ${results[0]?.memory.content ?? 'None'}`);
  } catch (e) {
    console.log("\nOllama not available. Install with: ollama pull nomic-embed-text");
  }
}

async function main() {
  await demo_semantic_search();
  await demo_with_ollama();
  
  console.log("\n" + "=".repeat(60));
  console.log("Done! See README for OpenAI embeddings usage.");
}

main().catch(console.error);
