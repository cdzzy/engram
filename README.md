# Engram

> Intelligent memory management system for AI agents.

Engram provides a sophisticated memory architecture for AI agents with automatic decay (Ebbinghaus forgetting curve), multi-level consolidation, version control, and cross-agent sharing.

## Features

- **Ebbinghaus Decay Engine** - Simulates human memory forgetting with configurable parameters
- **Memory Consolidation** - Compresses related weak memories into summaries
- **Version Control** - Full history with supersession and restore capabilities
- **Memory Spaces** - Shared memory with ACL-based access control
- **Multi-signal Recall** - Semantic, temporal, and importance-based ranking

## Installation

```bash
npm install engram
```

## Quick Start

```typescript
import { MemoryManager } from 'engram';

const memory = new MemoryManager({
  defaultNamespace: 'agent-memory',
  globalCapacity: 10000,
  decay: {
    initialStrength: 1.0,
    decayRate: 0.1,
    minStrength: 0.1,
  },
  compressionStrategy: 'hierarchical',
});

memory.start();

// Encode a new memory
const engram = await memory.encode({
  content: 'The user prefers dark mode UI',
  source: 'agent-1',
  importance: 0.8,
  tags: ['preference', 'ui'],
});

// Query memories
const results = await memory.query({
  namespace: 'agent-memory',
  query: 'user interface preferences',
  limit: 5,
});

// Reinforce important memories
await memory.get(engram.id, reinforce: true);

// Get version history
const history = memory.getVersionHistory(engram.id);
```

## Core Concepts

### Memory Lifecycle

```
encoded → active ←→ recalled → decayed → forgotten
                  ↘_ compressed
                  ↘_ archived
                  ↘_ superseded
```

### Memory States

| State | Description |
|-------|-------------|
| `active` | Recently accessed, full strength |
| `decayed` | Below minimum strength threshold |
| `compressed` | Consolidated into summary |
| `archived` | Long-term storage |
| `superseded` | Replaced by newer version |
| `forgotten` | Removed from active memory |

### Memory Spaces

Memory spaces provide isolated namespaces with access control:

```typescript
const space = memory.createSpace({
  name: 'team-workspace',
  members: ['agent-1', 'agent-2', 'agent-3'],
  permissions: {
    'agent-1': ['read', 'write', 'admin'],
    'agent-2': ['read', 'write'],
    'agent-3': ['read'],
  },
  capacity: 1000,
});
```

## API Overview

### Encoding

```typescript
memory.encode({
  content: string,
  source: string,        // agent ID
  namespace?: string,
  importance?: number,    // 0-1
  tags?: string[],
  metadata?: Record<string, unknown>,
}): Promise<Engram>
```

### Querying

```typescript
memory.query({
  namespace?: string,
  query?: string,         // semantic query
  tags?: string[],
  agentId?: string,       // filter by source
  minImportance?: number,
  maxResults?: number,
  timeRange?: { start: number; end: number },
}): Promise<RecallResult[]>
```

### Version Control

```typescript
// Update content (creates new version)
memory.update(engramId, newContent, agentId): Promise<Engram>

// Supersede with new memory
memory.supersede(oldEngramId, newOptions): Promise<{ old: Engram; new: Engram }>

// Restore previous version
memory.restore(engramId, targetVersion, agentId): Promise<Engram>

// Get version history
memory.getVersionHistory(engramId): VersionRecord[]
```

### Consolidation

```typescript
// Compress related memories
memory.consolidate({
  namespace: 'agent-memory',
  similarityThreshold: 0.7,
  maxGroupSize: 10,
}): Promise<CompressionResult[]>
```

## Architecture

```
engram/
├── src/
│   ├── index.ts              # Main exports
│   ├── engram.ts             # Memory entity
│   ├── memory-manager.ts     # Orchestration layer
│   ├── types.ts              # Type definitions
│   ├── decay-engine.ts      # Forgetting curve
│   ├── compressor.ts        # Memory consolidation
│   ├── recall-engine.ts     # Query & ranking
│   ├── version-manager.ts   # Version control
│   ├── memory-space.ts      # Access control
│   └── storage/
│       └── in-memory.ts      # Default storage
├── tests/
└── examples/
```

## Decay Configuration

```typescript
const config = {
  decay: {
    initialStrength: 1.0,      // Starting memory strength
    decayRate: 0.1,           // Base decay rate
    minStrength: 0.1,         // Threshold for "forgotten"
    stabilityThreshold: 0.8,  // Long-term memory threshold
    // Ebbinghaus parameters
    retentionInterval: 20 * 60 * 1000,  // 20 minutes
    savingsCoefficient: 0.7,  // Memory savings rate
  },
  decaySweepInterval: 60_000, // Check every minute
};
```

## Comparison

| Feature | Engram | supermemory |
|---------|--------|-------------|
| Decay simulation | ✅ | ❌ |
| Version control | ✅ | ❌ |
| Memory consolidation | ✅ | ❌ |
| Access control | ✅ | ✅ |
| Semantic search | ✅ | ✅ |

## License

MIT License
