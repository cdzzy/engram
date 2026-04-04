/**
 * Semantic Compression Strategy for Engram
 * 
 * Provides AI-powered semantic summarization of memories.
 * Reference: Inspired by claude-mem's AI compression approach.
 * 
 * This strategy uses an LLM to generate true semantic summaries
 * of memory groups, rather than simple concatenation.
 */

import type { Engram, CompressionStrategy } from './types';

export type LLMFunction = (prompt: string) => Promise<string>;

export interface SemanticCompressionOptions {
  /** LLM function for generating summaries */
  llmFn?: LLMFunction;
  /** Maximum length of generated summary */
  maxLength?: number;
  /** Prompt template for summarization */
  promptTemplate?: string;
  /** Whether to include memory metadata in summary */
  includeMetadata?: boolean;
}

/**
 * Default prompt template for semantic compression
 */
const DEFAULT_PROMPT_TEMPLATE = `You are a memory compression system. Your task is to create a concise, information-dense summary of the following memories.

Memories to summarize:
{{memories}}

Instructions:
1. Extract the key facts, insights, and patterns from these memories
2. Preserve important details, discard redundant information
3. Write in a neutral, factual tone
4. Keep the summary under {{maxLength}} characters
5. Focus on semantic content, not temporal sequence

Summary:`;

/**
 * Semantic compression strategy using LLM-powered summarization
 */
export class SemanticCompressionStrategy implements CompressionStrategy {
  private llmFn: LLMFunction;
  private maxLength: number;
  private promptTemplate: string;
  private includeMetadata: boolean;

  constructor(options: SemanticCompressionOptions = {}) {
    this.llmFn = options.llmFn || this.defaultLLM();
    this.maxLength = options.maxLength || 500;
    this.promptTemplate = options.promptTemplate || DEFAULT_PROMPT_TEMPLATE;
    this.includeMetadata = options.includeMetadata ?? false;
  }

  /**
   * Default LLM fallback - uses simple extraction when no LLM provided
   */
  private defaultLLM(): LLMFunction {
    return async (prompt: string) => {
      // Extract memories from prompt (simple parsing)
      const memoryMatch = prompt.match(/Memories to summarize:([\s\S]+?)Instructions:/);
      if (!memoryMatch) {
        return "Compressed memory content";
      }

      const memories = memoryMatch[1]
        .split('\n')
        .filter(line => line.trim().startsWith('-') || line.trim().startsWith('['))
        .slice(0, 3); // Take first 3

      if (memories.length === 0) {
        return "Compressed memory content";
      }

      // Simple extraction: combine first parts of each memory
      const combined = memories
        .map(m => m.replace(/^[-\[\]\s]+/, '').slice(0, 100))
        .join('; ');

      return `Key points: ${combined.slice(0, this.maxLength)}`;
    };
  }

  /**
   * Format memories for the LLM prompt
   */
  private formatMemories(memories: Engram[]): string {
    return memories
      .map((m, i) => {
        let formatted = `${i + 1}. [${m.type}] ${m.content.slice(0, 200)}`;
        
        if (this.includeMetadata) {
          const meta = [
            m.importance !== 'medium' && `importance: ${m.importance}`,
            m.tags.length > 0 && `tags: ${m.tags.join(', ')}`,
            m.strength < 0.5 && `strength: ${Math.round(m.strength * 100)}%`,
          ].filter(Boolean);
          
          if (meta.length > 0) {
            formatted += ` (${meta.join(', ')})`;
          }
        }
        
        return formatted;
      })
      .join('\n');
  }

  /**
   * Compress memories into semantic summary
   */
  async compress(memories: Engram[]): Promise<string> {
    if (memories.length === 0) {
      return '';
    }

    if (memories.length === 1) {
      return memories[0].content.slice(0, this.maxLength);
    }

    const formattedMemories = this.formatMemories(memories);
    
    const prompt = this.promptTemplate
      .replace('{{memories}}', formattedMemories)
      .replace('{{maxLength}}', String(this.maxLength));

    try {
      const summary = await this.llmFn(prompt);
      return summary.slice(0, this.maxLength).trim();
    } catch (error) {
      // Fallback to simple concatenation on error
      console.warn('Semantic compression failed, using fallback:', error);
      return this.fallbackCompress(memories);
    }
  }

  /**
   * Fallback compression when LLM fails
   */
  private fallbackCompress(memories: Engram[]): string {
    const sorted = [...memories].sort((a, b) => b.strength - a.strength);
    const keyPoints = sorted
      .slice(0, 3)
      .map(m => m.content.slice(0, 100))
      .join(' | ');
    
    return `Consolidated (${memories.length} memories): ${keyPoints}`;
  }
}

/**
 * Hierarchical semantic compression - multi-level summarization
 * 
 * L0: Raw episodic memories
 * L1: Group summaries (semantic compression)
 * L2: High-level abstractions (compress L1 summaries)
 */
export class HierarchicalSemanticStrategy implements CompressionStrategy {
  private level1Strategy: SemanticCompressionStrategy;
  private level2Strategy: SemanticCompressionStrategy;

  constructor(options: {
    level1?: SemanticCompressionOptions;
    level2?: SemanticCompressionOptions;
  } = {}) {
    this.level1Strategy = new SemanticCompressionStrategy({
      maxLength: 300,
      ...options.level1,
    });
    this.level2Strategy = new SemanticCompressionStrategy({
      maxLength: 200,
      promptTemplate: `Create a high-level abstraction of these memory summaries:

{{memories}}

Extract the core concepts and patterns. Be extremely concise.

Abstraction:`,
      ...options.level2,
    });
  }

  async compress(memories: Engram[]): Promise<string> {
    // Check if these are already L1 summaries
    const hasCompressedSource = memories.some(m => 
      m.compressedFrom && m.compressedFrom.length > 0
    );

    if (hasCompressedSource) {
      // These are L1 summaries, compress to L2
      return this.level2Strategy.compress(memories);
    } else {
      // These are raw memories, compress to L1
      return this.level1Strategy.compress(memories);
    }
  }
}

/**
 * Key-extraction compression - extracts only the most important information
 */
export class KeyExtractionStrategy implements CompressionStrategy {
  private llmFn: LLMFunction;
  private maxKeys: number;

  constructor(options: { llmFn?: LLMFunction; maxKeys?: number } = {}) {
    this.llmFn = options.llmFn || this.defaultLLM();
    this.maxKeys = options.maxKeys || 5;
  }

  private defaultLLM(): LLMFunction {
    return async () => "Key information extracted";
  }

  async compress(memories: Engram[]): Promise<string> {
    const sorted = [...memories].sort((a, b) => {
      // Sort by importance and strength
      const importanceOrder = ['critical', 'high', 'medium', 'low', 'trivial'];
      const impDiff = importanceOrder.indexOf(a.importance) - importanceOrder.indexOf(b.importance);
      if (impDiff !== 0) return impDiff;
      return b.strength - a.strength;
    });

    const topMemories = sorted.slice(0, this.maxKeys);
    
    const prompt = `Extract the ${this.maxKeys} most important facts from these memories:

${topMemories.map((m, i) => `${i + 1}. ${m.content.slice(0, 150)}`).join('\n')}

List only the key facts, one per line:`;

    try {
      const result = await this.llmFn(prompt);
      return result.trim();
    } catch {
      return topMemories.map(m => `• ${m.content.slice(0, 100)}`).join('\n');
    }
  }
}

/**
 * Create a semantic compressor with the given LLM
 */
export function createSemanticCompressor(
  llmFn: LLMFunction,
  options: Omit<SemanticCompressionOptions, 'llmFn'> = {}
): SemanticCompressionStrategy {
  return new SemanticCompressionStrategy({
    llmFn,
    ...options,
  });
}
