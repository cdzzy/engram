# engram 🧠

**为 AI 智能体设计的标准化长期记忆系统。**

就像人类记忆的文件系统 —— engram 为你的智能体提供持久化、可查询、支持衰减的记忆能力，跨会话稳定运行。

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue)](tsconfig.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-passing-brightgreen)](tests/)
[![npm](https://img.shields.io/badge/npm-engram-red)](https://www.npmjs.com/package/engram)

[English](./README.md) | **中文**

---

## 问题背景

每个 LLM 的上下文窗口都是临时的。关闭会话，智能体就会忘记一切。现有解决方案要么太简单（把历史记录一直堆积直到上下文溢出），要么太复杂（需要完整向量数据库基础设施）。

**Engram 填补了这个空白。** 这是一个专为智能体设计的结构化、可移植的记忆系统 —— 内置记忆衰减、回忆、压缩和版本控制能力。

---

## 功能特性

- 🗂️ **类型化记忆** — 支持情景记忆、语义记忆、程序记忆和工作记忆
- ⏳ **衰减引擎** — 记忆随时间自然淡忘，每种记忆类型可配置独立半衰期
- 🔍 **回忆引擎** — 多信号检索（时效性 + 重要性 + 频率 + 上下文匹配）
- 🗜️ **记忆压缩** — 整合旧记忆，节省上下文预算
- 📦 **记忆空间** — 按智能体/会话/项目隔离的独立命名空间
- 🔄 **版本控制** — 追踪记忆随时间的演变历程
- 💾 **可插拔存储** — 内置内存存储（默认）、SQLite、PostgreSQL 适配器
- 🎯 **零依赖** — 核心库仅使用 TypeScript 标准库

---

## 安装

```bash
npm install engram
```

持久化存储安装：
```bash
npm install engram better-sqlite3   # SQLite
npm install engram pg               # PostgreSQL
```

---

## 快速上手

```typescript
import { MemoryManager, createEngram } from 'engram';

const memory = new MemoryManager({ agentId: 'my-agent' });

// 存储一条记忆
await memory.store(createEngram({
  type: 'semantic',
  content: '用户偏好简洁回复，不使用项目符号',
  importance: 'high',
  tags: ['用户偏好', '风格'],
}));

// 回复前检索相关记忆
const relevant = await memory.recall({
  query: '我该如何格式化这个回复？',
  limit: 5,
});

console.log(relevant[0].content);
// → '用户偏好简洁回复，不使用项目符号'

// 衰减清扫（建议定期执行）
await memory.sweep();
```

---

## 记忆类型

| 类型 | 说明 | 默认半衰期 |
|------|------|-----------|
| `episodic` | 带时间戳的具体事件 | 7 天 |
| `semantic` | 事实与知识 | 30 天 |
| `procedural` | 操作方法与流程 | 90 天 |
| `working` | 临时信息，会话范围内有效 | 1 小时 |

---

## 重要性等级

```typescript
type ImportanceLevel = 'critical' | 'high' | 'medium' | 'low';
```

重要性会影响衰减速率、回忆排名和压缩优先级。

---

## 回忆引擎

多信号检索综合考量时效性、频率、重要性和上下文匹配：

```typescript
const results = await memory.recall({
  query: '用户支付偏好',
  tags: ['支付', '偏好'],
  types: ['semantic', 'episodic'],
  limit: 10,
  minScore: 0.5,
});
```

---

## 接入大模型

```typescript
import OpenAI from 'openai';
import { MemoryManager, createEngram } from 'engram';

const client = new OpenAI();
const memory = new MemoryManager({ agentId: 'assistant' });

async function chat(userMessage: string) {
  // 1. 检索相关记忆
  const memories = await memory.recall({ query: userMessage, limit: 3 });
  const context = memories.map(m => m.content).join('\n');

  // 2. 携带记忆上下文调用大模型
  const response = await client.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: `记忆上下文:\n${context}` },
      { role: 'user', content: userMessage },
    ],
  });

  const reply = response.choices[0].message.content!;

  // 3. 将本次对话存入记忆
  await memory.store(createEngram({
    type: 'episodic',
    content: `用户: ${userMessage} | 智能体: ${reply}`,
    importance: 'medium',
  }));

  return reply;
}
```

---

## 存储适配器

### 内存存储（默认）
```typescript
import { InMemoryStore, MemoryManager } from 'engram';
const manager = new MemoryManager({ store: new InMemoryStore() });
```

### SQLite（持久化）
```typescript
import { SQLiteStore } from 'engram/storage/sqlite';
import BetterSQLite3 from 'better-sqlite3';

const db = new BetterSQLite3('./agent-memory.db');
const manager = new MemoryManager({ store: new SQLiteStore(db) });
```

### PostgreSQL（多智能体）
```typescript
import { PostgreSQLStore } from 'engram/storage/postgresql';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const manager = new MemoryManager({ store: new PostgreSQLStore(pool) });
```

---

## 对比同类方案

| 功能 | Engram | LangChain Memory | Mem0 | 原始向量库 |
|------|--------|-----------------|------|-----------|
| 记忆衰减 | ✅ | ❌ | ❌ | ❌ |
| 零基础设施依赖 | ✅ | ✅ | ❌ | ❌ |
| 类型化记忆 | ✅ | ❌ | ⚠️ | ❌ |
| 可插拔存储 | ✅ | ⚠️ | ❌ | ✅ |
| 版本控制 | ✅ | ❌ | ❌ | ❌ |
| 智能体原生 API | ✅ | ⚠️ | ✅ | ❌ |

---

## 路线图

- [ ] 语义搜索适配器（自带 Embedding 模型）
- [ ] 通过 LLM 裁判自动评估重要性分值
- [ ] 智能体间共享记忆（多智能体记忆空间）
- [ ] 记忆快照导出/导入
- [ ] `engram` CLI 用于记忆检查与管理
- [ ] React Hook：`useAgentMemory()`

---

## 示例

```
examples/
  01_quickstart.ts          # 基础存储/回忆/衰减演示
  02_multi_agent.ts         # 多智能体共享记忆
  03_openai_integration.ts  # 带持久记忆的 ChatGPT 集成
  04_sqlite_persistence.ts  # SQLite 持久化存储
  05_memory_lifecycle.ts    # 完整衰减 + 压缩生命周期
```

---

## 许可证

MIT © cdzzy
