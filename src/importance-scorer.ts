/**
 * LLM Importance Scorer — automatically score memory importance using an LLM.
 *
 * The importance level of a memory affects:
 * - Decay rate (critical memories decay slower)
 * - Recall ranking (critical memories ranked higher)
 * - Compression priority (trivial memories compressed first)
 *
 * Instead of manually assigning importance, this scorer uses an LLM to
 * analyze memory content and assign an appropriate importance level.
 *
 * Usage:
 *   import { LLMImportanceScorer, ImportanceLevel } from 'engram';
 *
 *   const scorer = new LLMImportanceScorer({
 *     llm: openaiClient,        // OpenAI-compatible client
 *     model: 'gpt-4o-mini',
 *   });
 *
 *   const level = await scorer.score(
 *     'User prefers short responses. Never use bullet points.',
 *     'semantic',
 *   );
 *   // → 'high' (preference-related content)
 *
 *   const level = await scorer.score(
 *     'Meeting notes from standup: discussed sprint progress',
 *     'episodic',
 *   );
 *   // → 'medium'
 */

import type { Engram, ImportanceLevel, MemoryType } from './types.js';

// Keyword-based heuristics for quick classification
const IMPORTANCE_KEYWORDS: Record<ImportanceLevel, string[]> = {
  critical: [
    'security', 'password', 'secret', 'api-key', 'apikey', 'credentials',
    'emergency', 'critical', 'urgent', 'legal', 'compliance', 'violation',
    'payment', 'billing', 'confidential', 'pii', 'personally identifiable',
  ],
  high: [
    'preference', 'preferences', 'always', 'never', 'important', 'must',
    'requirement', 'rule', 'constraint', 'policy', 'standard', 'format',
    'deadline', 'priority', 'escalate', 'sensitive', 'personal',
  ],
  medium: [
    'remember', 'note', 'summary', 'report', 'meeting', 'discussed',
    'agreed', 'decided', 'action', 'task', 'project', 'feature',
  ],
  low: [
    'maybe', 'perhaps', 'might', 'possibly', 'optional', 'someday',
    'nice-to-have', 'future', 'later', 'if-time',
  ],
  trivial: [
    'greeting', 'hello', 'thanks', 'bye', 'acknowledged', 'okay',
    'sounds good', 'noted', 'seen', 'read',
  ],
};

export interface LLMImportanceScorerConfig {
  /** OpenAI-compatible LLM client (must implement chat completions) */
  llm: {
    chat: {
      completions: {
        create: (params: {
          model: string;
          messages: Array<{ role: string; content: string }>;
          temperature?: number;
        }) => Promise<{
          choices: Array<{ message: { content: string } }>;
        }>;
      };
    };
  };
  /** Model to use for scoring */
  model?: string;
  /** Fallback to heuristic when LLM is unavailable */
  fallbackToHeuristic?: boolean;
}

export class LLMImportanceScorer {
  private config: Required<LLMImportanceScorerConfig>;

  constructor(config: LLMImportanceScorerConfig) {
    this.config = {
      llm: config.llm,
      model: config.model ?? 'gpt-4o-mini',
      fallbackToHeuristic: config.fallbackToHeuristic ?? true,
    };
  }

  /**
   * Score a memory's importance using an LLM.
   *
   * @param content - The memory text to analyze
   * @param memoryType - The type of memory (episodic, semantic, etc.)
   * @returns The importance level
   */
  async score(content: string, memoryType?: MemoryType): Promise<ImportanceLevel> {
    const prompt = this._buildPrompt(content, memoryType);

    try {
      const response = await this.config.llm.chat.completions.create({
        model: this.config.model,
        messages: [
          {
            role: 'system',
            content: `You are an importance classifier for AI agent memories.
Analyze the memory content and classify its importance on behalf of a long-term memory system.
Output ONLY one word: critical, high, medium, low, or trivial.

Classification guidelines:
- critical: Security credentials, secrets, API keys, PII, legal/compliance matters, emergency protocols
- high: User preferences, hard rules, constraints, requirements, deadlines, personal info
- medium: Meeting notes, summaries, action items, project status, general knowledge
- low: Optional ideas, future possibilities, "nice to have" items
- trivial: Greetings, acknowledgments, transient small talk`,
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.1,  // Low temperature for consistent classification
      });

      const raw = response.choices[0]?.message?.content?.trim().toLowerCase() ?? '';
      const level = this._parseLevel(raw);

      if (level) return level;
      return this._heuristicScore(content);
    } catch (err) {
      if (this.config.fallbackToHeuristic) {
        return this._heuristicScore(content);
      }
      throw err;
    }
  }

  /**
   * Score multiple memories in a batch (more efficient for many memories).
   */
  async scoreBatch(
    items: Array<{ content: string; memoryType?: MemoryType }>,
  ): Promise<ImportanceLevel[]> {
    const prompt = items
      .map((item, i) => {
        const type = item.memoryType ?? 'episodic';
        return `[${i + 1}] (${type}): ${item.content}`;
      })
      .join('\n');

    const systemPrompt = `You are an importance classifier for AI agent memories.
For each item below, output ONLY the importance level as a single word per line.
Output exactly ${items.length} lines, one per item.

Levels: critical, high, medium, low, trivial`;

    try {
      const response = await this.config.llm.chat.completions.create({
        model: this.config.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        temperature: 0.1,
      });

      const lines = response.choices[0]?.message?.content?.trim().split('\n') ?? [];
      return items.map((_, i) => {
        const line = lines[i]?.trim().toLowerCase() ?? '';
        return this._parseLevel(line) ?? this._heuristicScore(items[i].content);
      });
    } catch (err) {
      if (this.config.fallbackToHeuristic) {
        return items.map((item) => this._heuristicScore(item.content));
      }
      throw err;
    }
  }

  private _buildPrompt(content: string, memoryType?: MemoryType): string {
    const typeNote = memoryType ? `(memory type: ${memoryType})` : '';
    return `Memory content ${typeNote}:\n${content}`;
  }

  private _parseLevel(raw: string): ImportanceLevel | null {
    const levels: ImportanceLevel[] = ['critical', 'high', 'medium', 'low', 'trivial'];
    return levels.find((l) => raw.includes(l)) ?? null;
  }

  /**
   * Fallback: heuristic-based importance scoring without LLM.
   */
  _heuristicScore(content: string): ImportanceLevel {
    const lower = content.toLowerCase();

    // Check critical keywords
    if (IMPORTANCE_KEYWORDS.critical.some((kw) => lower.includes(kw))) {
      return 'critical';
    }

    // Check high keywords
    if (IMPORTANCE_KEYWORDS.high.some((kw) => lower.includes(kw))) {
      return 'high';
    }

    // Check low keywords
    if (IMPORTANCE_KEYWORDS.low.some((kw) => lower.includes(kw))) {
      return 'low';
    }

    // Check trivial keywords
    if (IMPORTANCE_KEYWORDS.trivial.some((kw) => lower.includes(kw))) {
      return 'trivial';
    }

    return 'medium';
  }
}

