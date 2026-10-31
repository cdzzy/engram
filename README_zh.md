# engram 🧠

**为 AI 智能体设计的标准化长期记忆系统。**

就像人类记忆的文件系统 —— engram 为你的智能体提供持久化、可查询、支持衰减的记忆能力，跨会话稳定运行。

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue)](tsconfig.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-passing-brightgreen)](tests/)
[![CI](https://github.com/cdzzy/engram/actions/workflows/ci.yml/badge.svg)](https://github.com/cdzzy/engram/actions/workflows/ci.yml)
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
- 🗑️ **软删除与物理删除** — `delete()` 标记（状态流转），`undelete()` 恢复，`purge()` 物理删除
- ⏲️ **到期时间** — `expiration_date` 元数据，读取时惰性判定到期（无需后台任务）
- 📉 **召回时间衰减** — 可配置的指数/幂衰减因子与半衰期
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

## 软衰减（软删除、到期与时间衰减召回）

删除不再意味着数据丢失，而是一次状态流转。记忆状态：
`active | decayed | compressed | archived | superseded | forgotten | expired`。

### 软删除 / 恢复 / 物理删除

`delete()` 不再移除数据，而是将记忆标记为 `status: 'archived'` 并写入
`deletedAt` 元数据时间戳。软删除的记忆从召回结果中消失，但在 `purge()`
之前始终可以恢复：

```typescript
await memory.delete(id);      // 软删除 → status 'archived'，带 deletedAt 标记
await memory.get(id);         // 仍可读取（status 'archived'）
await memory.undelete(id);    // 恢复 → status 'active'，移除标记
await memory.purge(id);       // 物理删除 —— 唯一不可逆的 API
```

软删除的记忆不会出现在 `query()` 结果中，也不会被读取强化；衰减清扫同样
不会触碰它们，直到显式 `purge()` 为止。

### 到期时间（expiration_date）

在元数据中附加 `expiration_date`（ISO 字符串或毫秒时间戳）。到期判定是
惰性的：`get()` / `query()` 在截止时间之后第一次触达该记忆时，自动将其
流转为 `status: 'expired'` —— 无需定时器或后台任务：

```typescript
await memory.encode({
  content: '会话令牌缓存',
  type: 'episodic',
  source: 'agent-1',
  metadata: { expiration_date: new Date(Date.now() + 3_600_000).toISOString() },
});
```

只有 `active` / `decayed` / `compressed` 状态的记忆会到期；终态与软删除的
记忆不受影响。

### 召回时间衰减因子

召回打分可乘以基于记忆年龄（自 `createdAt` 起）的可配置衰减因子，半衰期
参数可配。支持两种形式，均在半衰期处等于 0.5：

```typescript
const memory = new MemoryManager({
  recallTimeDecay: { type: 'exponential', halfLife: 86_400_000 }, // 指数：0.5^(age / 半衰期)
  // 或 { type: 'power', halfLife: 86_400_000 }                   // 幂：1 / (1 + age / 半衰期)
});
```

不配置 `recallTimeDecay` 时保持原有行为（不乘额外因子）。

### 加密依然生效

AES-256-GCM 加密与状态无关：archived / expired 状态的记忆在磁盘上保持
加密，读取时透明解密。

---

## 多智能体共享记忆

记忆空间（memory space）是带 ACL 的命名空间，让一组智能体共享各自学到的知识，
而不至于把所有记忆对所有人敞开。写入与读取都走同一套 ACL 校验。

```typescript
import { MemoryManager } from 'engram';

const manager = new MemoryManager();

// 创建跨智能体空间；创建者拿到 admin，可以继续分授权限
manager.createSharedSpace('team', 'researcher');

manager.grantAccess('team', 'writer', ['read', 'write']);
manager.grantAccess('team', 'auditor', ['read']);

// 写入按空间 ACL 校验（智能体 id 即 `source`）
await manager.encode({
  content: '第三季度营收增长 18%',
  type: 'semantic',
  source: 'writer',      // 在 'team' 上有 write 权限
  namespace: 'team',
});

// 带作用域的读取只返回该智能体可读的空间
const visible = await manager.queryAs('auditor');     // 'team' + 'default'
const hidden = await manager.queryAs('outsider');     // 只有 'default'

// 不带作用域的读取保持原有行为（不做智能体过滤）
const all = await manager.query({ namespace: 'team' });

manager.revokeAccess('team', 'auditor');
```

**能力清单**

- `createSharedSpace(name, ownerAgentId)` —— 创建 `shared` 空间，创建者默认为
  `admin`，容量默认不限。
- `grantAccess` / `revokeAccess` / `getAccessList` / `getSpaceAgents` /
  `canAccess` —— ACL 管理，并分别触发 `space:access-granted` /
  `space:access-revoked` 事件。
- **读隔离** —— `query({ agentId })` 与 `get(id, reinforce, agentId)`（或
  `queryAs` / `getAs` 简写）会把结果过滤到该智能体持有 `read` 权限的命名空间。
  显式指定不可读命名空间的查询会直接短路返回 `[]`，不触碰存储层。`default`
  命名空间对所有智能体保持开放。
- **写隔离** —— `encode()` 早已校验目标命名空间的 `write` 权限，无写权限的
  智能体无法污染空间。
- **容量与冲突信号** —— 占用达 90% 触发 `space:capacity-warning`；两个智能体
  在冲突窗口内写同一条记忆会触发 `memory:conflict`。
- `listSharedSpaces()` / `listAgentSpaces(agentId)` 用于发现空间。

不传 `agentId` 时所有调用完全向后兼容：既有单智能体代码不受影响，也没有
额外开销。

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
- [x] **智能体间共享记忆（多智能体记忆空间）**（`createSharedSpace` + ACL 授权/撤销 + `agentId` 读数隔离）✅ (v0.13.0)
- [ ] 记忆快照导出/导入
- [ ] `engram` CLI 用于记忆检查与管理
- [ ] React Hook：`useAgentMemory()`
- [x] **软衰减**（软删除/恢复/物理删除、`expiration_date` 惰性到期、召回时间衰减因子）✅ (v0.8.0)

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

