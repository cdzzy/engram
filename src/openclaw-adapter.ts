/**
 * OpenClaw `.agent/` memory compatibility layer (Roadmap).
 *
 * Bridges engram memories and the portable `.agent/` directory convention used
 * by agentic-stack / OpenClaw tools (and agentconfig's `portable` module):
 *
 *   .agent/
 *   ||| memory/
 *   |?  ||| working/          |?short-term (working memories)
 *   |?  ||| episodic/         |?historical logs (episodic memories)
 *   |?  ||| semantic/
 *   |?  |?  ||| lessons.jsonl |?graduated lessons (one JSON object per line)
 *   |?  |?  ||| LESSONS.md    |?rendered markdown
 *   |?  ||| personal/
 *   |?      ||| PREFERENCES.md
 *
 * Usage::
 *   import { importAgentDir, exportToAgentDir } from 'engram';
 *
 *   // Pull lessons + episodic logs into the memory manager
 *   const imported = await importAgentDir(manager, "./.agent");
 *
 *   // Persist memories back into the portable layout
 *   await exportToAgentDir(manager, "./.agent");
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MemoryManager } from './memory-manager.js';
import type { Engram, MemoryType, ImportanceLevel } from './types.js';

const DIR_MEMORY = 'memory';
const DIR_SEMANTIC = path.join(DIR_MEMORY, 'semantic');
const DIR_EPISODIC = path.join(DIR_MEMORY, 'episodic');
const FILE_LESSONS_JSONL = path.join(DIR_SEMANTIC, 'lessons.jsonl');
const FILE_LESSONS_MD = path.join(DIR_SEMANTIC, 'LESSONS.md');

export interface AgentDirImportResult {
  imported: number;
  skipped: number;
  sources: { lessons: number; episodic: number };
}

interface LessonRecord {
  lesson?: string;
  content?: string;
  category?: string;
  rationale?: string;
  [key: string]: unknown;
}

function toImportance(level: string | undefined): ImportanceLevel {
  const lower = (level ?? '').toLowerCase();
  if (lower === 'critical' || lower === 'high' || lower === 'medium' || lower === 'low' || lower === 'trivial') {
    return lower as ImportanceLevel;
  }
  return 'medium';
}

/**
 * Import memories from a `.agent/` directory into a MemoryManager.
 *
 * Reads `memory/semantic/lessons.jsonl` (one JSON object per line) and any
 * `.json` files inside `memory/episodic/`. Existing memories with the same
 * id are skipped unless `overwrite` is set.
 */
export async function importAgentDir(
  manager: MemoryManager,
  agentDir: string,
  options: { overwrite?: boolean } = {},
): Promise<AgentDirImportResult> {
  const result: AgentDirImportResult = {
    imported: 0, skipped: 0,
    sources: { lessons: 0, episodic: 0 },
  };

  // || Lessons (semantic memories) ||||||||||||||||||||||||||||||||||||||
  const lessonsPath = path.join(agentDir, FILE_LESSONS_JSONL);
  if (fs.existsSync(lessonsPath)) {
    for (const line of fs.readFileSync(lessonsPath, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let record: LessonRecord;
      try {
        record = JSON.parse(trimmed) as LessonRecord;
      } catch {
        result.skipped += 1;
        continue;
      }
      const text = record.lesson ?? record.content ?? '';
      if (!text) {
        result.skipped += 1;
        continue;
      }
      await manager.encode({
        content: text,
        type: 'semantic' as MemoryType,
        importance: toImportance(record.category === 'critical' ? 'high' : undefined),
        source: record.category ?? 'openclaw-lessons',
        tags: ['lesson', record.category ?? 'general'],
        metadata: { origin: '.agent', rationale: record.rationale },
        namespace: 'default',
      });
      result.imported += 1;
      result.sources.lessons += 1;
    }
  }

  // || Episodic .json files |||||||||||||||||||||||||||||||||||||||||||||
  const episodicDir = path.join(agentDir, DIR_EPISODIC);
  if (fs.existsSync(episodicDir)) {
    for (const file of fs.readdirSync(episodicDir).filter((f) => f.endsWith('.json'))) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(episodicDir, file), 'utf-8'));
        const records = Array.isArray(raw) ? raw : [raw];
        for (const record of records) {
          const content = typeof record === 'string' ? record : (record?.content ?? record?.lesson ?? '');
          if (!content) {
            result.skipped += 1;
            continue;
          }
          await manager.encode({
            content: String(content),
            type: 'episodic' as MemoryType,
            importance: 'medium',
            source: 'openclaw-episodic',
            namespace: 'default',
          });
          result.imported += 1;
          result.sources.episodic += 1;
        }
      } catch {
        result.skipped += 1;
      }
    }
  }

  return result;
}

/**
 * Export memories from a MemoryManager into a `.agent/` directory:
 * - memories tagged or typed `semantic` |?lessons.jsonl + LESSONS.md
 * - memories typed `episodic` |?memory/episodic/<id>.json
 */
export async function exportToAgentDir(
  manager: MemoryManager,
  agentDir: string,
  options: { limit?: number } = {},
): Promise<{ lessonsWritten: number; episodicWritten: number }> {
  const memories = await manager.store.query({});
  const limit = options.limit ?? 5000;
  const selected = memories.slice(0, limit);

  const semantic = selected.filter((m) => m.type === 'semantic' && m.status === 'active');
  const episodic = selected.filter((m) => m.type === 'episodic' && m.status === 'active');

  // lessons.jsonl
  const lessonsPath = path.join(agentDir, FILE_LESSONS_JSONL);
  fs.mkdirSync(path.dirname(lessonsPath), { recursive: true });
  const lines = semantic.map((m) =>
    JSON.stringify({ lesson: m.content, category: m.tags[0] ?? 'general', graduated_at: new Date(m.createdAt).toISOString() }),
  );
  fs.writeFileSync(lessonsPath, lines.join('\n') + (lines.length ? '\n' : ''), 'utf-8');

  // LESSONS.md
  const mdPath = path.join(agentDir, FILE_LESSONS_MD);
  const mdLines = ['# Lessons', ''];
  semantic.forEach((m, i) => {
    mdLines.push(`## ${i + 1}. ${(m.tags[0] ?? 'general').replace(/^\w/, (c) => c.toUpperCase())}`);
    mdLines.push('');
    mdLines.push(m.content);
    mdLines.push('');
  });
  fs.writeFileSync(mdPath, mdLines.join('\n'), 'utf-8');

  // episodic JSON files
  const episodicDir = path.join(agentDir, DIR_EPISODIC);
  fs.mkdirSync(episodicDir, { recursive: true });
  for (const m of episodic) {
    fs.writeFileSync(
      path.join(episodicDir, `${m.id}.json`),
      JSON.stringify({ id: m.id, content: m.content, createdAt: m.createdAt, source: m.source }, null, 2),
      'utf-8',
    );
  }

  return { lessonsWritten: semantic.length, episodicWritten: episodic.length };
}
