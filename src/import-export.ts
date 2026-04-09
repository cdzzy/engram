/**
 * Import/Export Module for Engram
 * 
 * Supports backing up, migrating, and sharing memory spaces.
 * Formats: JSON, JSONL, Markdown (for human readability)
 */

import type { Engram, MemorySpace } from './types.js';

export interface ExportOptions {
  format: 'json' | 'jsonl' | 'markdown';
  includeMetadata?: boolean;
  includeEmbeddings?: boolean;
  filter?: {
    type?: Engram['type'];
    namespace?: string;
    tags?: string[];
    minImportance?: Engram['importance'];
    since?: number;
    until?: number;
  };
}

export interface ImportOptions {
  namespace?: string;
  overwriteExisting?: boolean;
  updateTimestamps?: boolean;
}

/**
 * Export memory space to various formats
 */
export async function exportMemory(
  memories: Engram[],
  options: ExportOptions
): Promise<string> {
  const filtered = filterMemories(memories, options.filter);

  switch (options.format) {
    case 'json':
      return exportToJson(filtered, options);
    case 'jsonl':
      return exportToJsonl(filtered, options);
    case 'markdown':
      return exportToMarkdown(filtered, options);
    default:
      throw new Error(`Unsupported export format: ${options.format}`);
  }
}

function filterMemories(memories: Engram[], filter?: ExportOptions['filter']): Engram[] {
  if (!filter) return memories;

  return memories.filter((m) => {
    if (filter.type && m.type !== filter.type) return false;
    if (filter.namespace && m.namespace !== filter.namespace) return false;
    if (filter.tags && !filter.tags.some((t) => m.tags.includes(t))) return false;
    if (filter.minImportance) {
      const levels = ['low', 'medium', 'high', 'critical'];
      const minIdx = levels.indexOf(filter.minImportance);
      const memIdx = levels.indexOf(m.importance);
      if (memIdx < minIdx) return false;
    }
    if (filter.since && m.createdAt < filter.since) return false;
    if (filter.until && m.createdAt > filter.until) return false;
    return true;
  });
}

function exportToJson(memories: Engram[], options: ExportOptions): string {
  const result = memories.map((m) => sanitizeForExport(m, options));
  return JSON.stringify(result, null, 2);
}

function exportToJsonl(memories: Engram[], options: ExportOptions): string {
  return memories
    .map((m) => JSON.stringify(sanitizeForExport(m, options)))
    .join('\n');
}

function exportToMarkdown(memories: Engram[], options: ExportOptions): string {
  const lines: string[] = [
    '# Engram Memory Export',
    '',
    `**Exported:** ${new Date().toISOString()}`,
    `**Total memories:** ${memories.length}`,
    '',
    '---',
    '',
  ];

  for (const memory of memories) {
    lines.push(`## ${memory.id.slice(0, 8)}`);
    lines.push('');
    lines.push(`- **Type:** ${memory.type}`);
    lines.push(`- **Importance:** ${memory.importance}`);
    lines.push(`- **Created:** ${new Date(memory.createdAt).toLocaleString()}`);
    lines.push(`- **Last accessed:** ${new Date(memory.lastAccessedAt).toLocaleString()}`);
    lines.push(`- **Access count:** ${memory.accessCount}`);
    if (memory.tags.length > 0) {
      lines.push(`- **Tags:** ${memory.tags.join(', ')}`);
    }
    if (memory.source) {
      lines.push(`- **Source:** ${memory.source}`);
    }
    lines.push('');
    lines.push('### Content');
    lines.push('');
    lines.push(memory.content);
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

function sanitizeForExport(memory: Engram, options: ExportOptions): Record<string, unknown> {
  const obj: Record<string, unknown> = {
    id: memory.id,
    content: memory.content,
    type: memory.type,
    importance: memory.importance,
    status: memory.status,
    strength: memory.strength,
    stability: memory.stability,
    lastAccessedAt: memory.lastAccessedAt,
    accessCount: memory.accessCount,
    createdAt: memory.createdAt,
    tags: memory.tags,
    source: memory.source,
    namespace: memory.namespace,
    version: memory.version,
  };

  if (options.includeMetadata !== false) {
    obj.metadata = memory.metadata;
  }

  if (options.includeEmbeddings && memory.embedding) {
    obj.embedding = memory.embedding;
  }

  return obj;
}

/**
 * Import memories from various formats
 */
export async function importMemories(
  data: string,
  options: ImportOptions = {}
): Promise<Partial<Engram>[]> {
  const dataTrimmed = data.trim();

  // Try to detect format
  if (dataTrimmed.startsWith('[')) {
    return importFromJson(dataTrimmed, options);
  } else if (dataTrimmed.includes('\n')) {
    // Could be JSONL or Markdown
    const firstLine = dataTrimmed.split('\n')[0];
    if (firstLine.startsWith('{')) {
      return importFromJsonl(dataTrimmed, options);
    } else if (firstLine.startsWith('#')) {
      return importFromMarkdown(dataTrimmed, options);
    }
  }

  // Default to JSON
  return importFromJson(dataTrimmed, options);
}

function importFromJson(data: string, options: ImportOptions): Partial<Engram>[] {
  try {
    const parsed = JSON.parse(data);
    const memories = Array.isArray(parsed) ? parsed : [parsed];
    return memories.map((m) => transformImport(m, options));
  } catch (e) {
    throw new Error(`Invalid JSON format: ${e}`);
  }
}

function importFromJsonl(data: string, options: ImportOptions): Partial<Engram>[] {
  const lines = data.split('\n').filter((l) => l.trim());
  const results: Partial<Engram>[] = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      results.push(transformImport(parsed, options));
    } catch (e) {
      console.warn(`Skipping invalid line: ${line.slice(0, 50)}...`);
    }
  }

  return results;
}

function importFromMarkdown(data: string, options: ImportOptions): Partial<Engram>[] {
  const results: Partial<Engram>[] = [];
  const sections = data.split(/^## /m).filter((s) => s.trim());

  for (const section of sections) {
    if (section.startsWith('#')) continue; // Skip header

    const lines = section.split('\n');
    const contentLines: string[] = [];
    let metadata: Record<string, string> = {};

    for (const line of lines) {
      if (line.startsWith('### Content')) {
        // Start capturing content
        continue;
      }
      if (line.startsWith('- **')) {
        const match = line.match(/- \*\*(\w+):\*\* (.+)/);
        if (match) {
          metadata[match[1].toLowerCase()] = match[2];
        }
      } else if (line.startsWith('##')) {
        break; // Next section
      } else if (line.trim()) {
        contentLines.push(line.trim());
      }
    }

    if (contentLines.length > 0) {
      results.push({
        id: metadata.id || undefined,
        content: contentLines.join('\n'),
        type: (metadata.type as Engram['type']) || 'episodic',
        importance: (metadata.importance as Engram['importance']) || 'medium',
        tags: metadata.tags ? metadata.tags.split(', ').map((t) => t.trim()) : [],
        source: metadata.source || 'imported',
        namespace: options.namespace || metadata.namespace || 'default',
        createdAt: metadata.created ? new Date(metadata.created).getTime() : Date.now(),
        status: 'active',
        strength: 1.0,
        stability: 1.0,
        accessCount: 0,
        lastAccessedAt: Date.now(),
        version: 1,
      });
    }
  }

  return results;
}

function transformImport(
  data: Record<string, unknown>,
  options: ImportOptions
): Partial<Engram> {
  return {
    id: data.id as string | undefined,
    content: data.content as string,
    type: (data.type as Engram['type']) || 'episodic',
    importance: (data.importance as Engram['importance']) || 'medium',
    tags: (data.tags as string[]) || [],
    source: (data.source as string) || 'imported',
    namespace: options.namespace || (data.namespace as string) || 'default',
    metadata: (data.metadata as Record<string, unknown>) || {},
    embedding: options.includeEmbeddings ? (data.embedding as number[]) || null : null,
    createdAt: options.updateTimestamps ? Date.now() : (data.createdAt as number) || Date.now(),
    lastAccessedAt: options.updateTimestamps ? Date.now() : (data.lastAccessedAt as number) || Date.now(),
    status: 'active',
    strength: 1.0,
    stability: 1.0,
    accessCount: 0,
    version: 1,
  };
}

export default { exportMemory, importMemories };
