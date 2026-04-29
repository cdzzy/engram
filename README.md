# engram 🧠

**Standardized long-term memory for AI agents.**

Like a filesystem for human memory — engram gives your agents persistent, queryable, decay-aware memory that works across sessions.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue)](tsconfig.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-passing-brightgreen)](tests/)
[![npm](https://img.shields.io/badge/npm-engram-red)](https://www.npmjs.com/package/engram)

---

## The Problem

Every LLM context window is ephemeral. Close the session, and the agent forgets everything. Today's solutions are either too simple (just dump history until context limit) or too complex (full vector DB requiring infrastructure).

**Engram is the missing layer.** A structured, portable memory system built specifically for agents — with decay, recall, compression, and versioning built in.

---

## Features

- 🗂️ **Typed memory** — episodic, semantic, procedural, working memory
- ⏳ **Decay engine** — memories fade over time with configurable half-lives per memory type
- 🔍 **Recall engine** — multi-signal retrieval (recency + importance + frequency + context)
- 🗜️ **Compression** — consolidate old memories to save context budget
- 📦 **Memory spaces** — isolated namespaces per agent/session/project
- 🔄 **Versioning** — track how memories evolve over time
- 💾 **Pluggable storage** — in-memory (default), **FileStore (new: filesystem persistence, zero deps)**, SQLite, PostgreSQL adapters
- 🔌 **MCP Server** — expose memory as MCP tools, callable from Claude Code, Cursor, Cline
- 🎯 **Zero dependencies** — core library uses only Node.js built-ins

---

## Installation

```bash
npm install engram
```

For persistent storage:
```bash
npm install engram better-sqlite3   # SQLite
npm install engram pg                # PostgreSQL
```

---

## Quick Start

```typescript
import { MemoryManager, createEngram } from 'engram';

const memory = new MemoryManager({ agentId: 'my-agent' });

// Store a memory
await memory.store(createEngram({
  type: 'semantic',
  content: 'User prefers concise responses without bullet points',
  importance: 'high',
  tags: ['user-preference', 'style'],
}));

// Recall before responding
const relevant = await memory.recall({
  query: 'How should I format this response?',
  limit: 5,
});

console.log(relevant[0].content);
// → 'User prefers concise responses without bullet points'

// Decay sweep (run periodically)
await memory.sweep();
```

---

## Memory Types

| Type | Description | Default Half-Life |
|------|-------------|-------------------|
| `episodic` | Specific events with timestamp | 7 days |
| `semantic` | Facts and knowledge | 30 days |
| `procedural` | How to do things | 90 days |
| `working` | Temporary, session-scoped | 1 hour |

---

## Importance Levels

```typescript
type ImportanceLevel = 'critical' | 'high' | 'medium' | 'low';
```

Importance affects decay rate, recall ranking, and compression priority.

---

## Recall Engine

Multi-signal retrieval combines recency, frequency, importance, and context match:

```typescript
const results = await memory.recall({
  query: 'user payment preferences',
  tags: ['payment', 'preference'],
  types: ['semantic', 'episodic'],
  limit: 10,
  minScore: 0.5,
});
```

---

## LLM Integration

```typescript
import OpenAI from 'openai';
import { MemoryManager, createEngram } from 'engram';

const client = new OpenAI();
const memory = new MemoryManager({ agentId: 'assistant' });

async function chat(userMessage: string) {
  // 1. Recall relevant memories
  const memories = await memory.recall({ query: userMessage, limit: 3 });
  const context = memories.map(m => m.content).join('\n');

  // 2. Call LLM with memory context
  const response = await client.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: `Memory context:\n${context}` },
      { role: 'user', content: userMessage },
    ],
  });

  const reply = response.choices[0].message.content!;

  // 3. Store the interaction
  await memory.store(createEngram({
    type: 'episodic',
    content: `User: ${userMessage} | Agent: ${reply}`,
    importance: 'medium',
  }));

  return reply;
}
```

---

## Storage Adapters

### In-Memory (default, no persistence)
```typescript
import { InMemoryStore, MemoryManager } from 'engram';

const manager = new MemoryManager({}, new InMemoryStore());
```

### FileStore (persistent, zero dependencies)
```typescript
import { FileStore, MemoryManager } from 'engram';

const store = new FileStore('.agent/memory');
await store.init();   // creates directory; rebuilds index if needed

const manager = new MemoryManager({}, store);
manager.start();

// On shutdown — flush any pending index writes
await store.flush();
```

Each memory is stored as an individual JSON file. A lightweight `_index.json`
enables fast queries without reading every file. No external dependencies required.

### SQLite (persistent, multi-session)
```typescript
import { SQLiteStore } from 'engram/storage/sqlite';
import BetterSQLite3 from 'better-sqlite3';

const db = new BetterSQLite3('./agent-memory.db');
const manager = new MemoryManager({}, new SQLiteStore(db));
```

---

## MCP Server — Expose Memory to AI Tools

Make Engram callable from Claude Code, Cursor, Cline, or any MCP client:

```typescript
import { MemoryManager, MCPToolsAdapter, FileStore } from 'engram';

const store = new FileStore('.agent/memory');
await store.init();

const manager = new MemoryManager({}, store);
manager.start();

// Start MCP server (blocking)
const mcp = new MCPToolsAdapter(manager);
mcp.serveForever({ port: 8766 });
```

Add to your Claude Code / Cursor `.mcp.json`:
```json
{
  "mcpServers": {
    "engram": {
      "url": "http://localhost:8766",
      "transport": "http"
    }
  }
}
```

Exposed MCP tools:

| Tool | Description |
|------|-------------|
| `engram_store` | Store a new memory |
| `engram_recall` | Query memories by keywords, type, strength |
| `engram_get` | Get a specific memory by ID |
| `engram_update` | Update memory content (creates new version) |
| `engram_sweep` | Trigger Ebbinghaus decay sweep |
| `engram_stats` | Memory statistics by namespace |
| `engram_consolidate` | Compress weak memories into summaries |

---


## Comparison

| Feature | Engram | LangChain Memory | Mem0 | Raw Vector DB |
|---------|--------|-----------------|------|---------------|
| Memory decay | ✅ | ❌ | ❌ | ❌ |
| Zero infrastructure | ✅ | ✅ | ❌ | ❌ |
| Typed memory | ✅ | ❌ | ⚠️ | ❌ |
| Pluggable storage | ✅ | ⚠️ | ❌ | ✅ |
| Versioning | ✅ | ❌ | ❌ | ❌ |
| Agent-native API | ✅ | ⚠️ | ✅ | ❌ |

---

## Roadmap

- [x] **Semantic search adapter** (bring-your-own embeddings) ✅ (src/semantic-search.ts)
- [x] **Auto-importance scoring via LLM judge** ✅ (src/importance-scorer.ts)
- [x] **Shared memory between agents** (multi-agent memory spaces) ✅ (src/memory-space.ts)
- [x] **FileStore** (filesystem persistence, zero dependencies) ✅ (src/storage/file-store.ts)
- [x] **MCP Server** (expose memory as MCP tools) ✅ (src/mcp-adapter.ts)
- [ ] Memory snapshot export/import
- [ ] `engram` CLI for memory inspection
- [ ] React hook: `useAgentMemory()`
- [ ] OpenClaw `.agent/memory` format compatibility layer

---

## Examples

```
examples/
  01_quickstart.ts          # Basic store/recall/decay
  02_multi_agent.ts         # Shared memory between agents
  03_openai_integration.ts  # ChatGPT with persistent memory
  04_sqlite_persistence.ts  # SQLite-backed memory
  05_memory_lifecycle.ts    # Full decay + compression lifecycle
```

---

## License

MIT © cdzzy

