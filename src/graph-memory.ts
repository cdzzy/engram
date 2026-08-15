/**
 * GraphMemory — knowledge-graph memory with entity/relation extraction and
 * multi-hop traversal.
 *
 * Addresses the vector-only limitation: multi-hop queries like "Who are the
 * colleagues of the person who approved my request?" require traversing
 * relationships between entities, which pure embedding search cannot do.
 *
 * The extraction is rule-based and dependency-free; plug in an LLM extractor
 * via `GraphMemoryConfig.extractor` for richer results.
 *
 * Usage:
 *   import { GraphMemory } from './graph-memory';
 *
 *   const graph = new GraphMemory({ autoExtract: true });
 *
 *   await graph.store("Alice approved Bob's vacation request");
 *   // Auto-extracts: Entity(Alice), Entity(Bob), Relation(approved, Alice → Bob)
 *
 *   const result = await graph.traverse("Alice", { maxHops: 2 });
 */

export interface GraphEntity {
  id: string;
  name: string;
  type: string;
  firstSeenAt: number;
  lastSeenAt: number;
  mentionCount: number;
}

export interface GraphRelation {
  id: string;
  fromId: string;
  toId: string;
  relation: string;
  createdAt: number;
}

export interface ExtractionResult {
  entities: GraphEntity[];
  relations: GraphRelation[];
}

export interface TraversalNode {
  entity: GraphEntity;
  depth: number;
  relation: string;      // relation that led to this node ('' for root)
  viaEntityId: string | null;
}

export interface GraphMemoryConfig {
  /** Auto-extract entities/relations on store() (default: true) */
  autoExtract?: boolean;
  /** Recognized relationship verbs (additional verbs are accepted as custom) */
  relationshipTypes?: string[];
  /** Optional custom extractor: content → entities/relations */
  extractor?: (content: string) => Promise<ExtractionResult> | ExtractionResult;
}

export interface GraphMemoryStats {
  entities: number;
  relations: number;
}

const DEFAULT_RELATIONSHIP_TYPES = [
  'works_with', 'reported_to', 'depends_on', 'part_of', 'related_to',
  'caused_by', 'approved', 'assigned', 'reviews', 'manages', 'owns',
  'created', 'supervises', 'blocked_by', 'precedes', 'supports', 'contradicts',
];

// Common relationship verbs → canonical relationship type
const RELATION_VERB_MAP: Record<string, string> = {
  approved: 'approved',
  approves: 'approved',
  assigned: 'assigned',
  works_with: 'works_with',
  reported_to: 'reported_to',
  reports_to: 'reported_to',
  depends_on: 'depends_on',
  part_of: 'part_of',
  related_to: 'related_to',
  caused_by: 'caused_by',
  manages: 'manages',
  managed: 'manages',
  owns: 'owns',
  created: 'created',
  supervises: 'supervises',
  reviews: 'reviews',
  supports: 'supports',
  contradicts: 'contradicts',
  precedes: 'precedes',
  blocked_by: 'blocked_by',
  blocks: 'blocked_by',
};

let entityCounter = 0;
function nextId(prefix: string): string {
  entityCounter += 1;
  return `${prefix}_${entityCounter}_${Date.now().toString(36)}`;
}

function canonicalize(name: string): string {
  return name
    .trim()
    .replace(/['\u2019]s$/i, '')   // strip possessive "Bob's" → "Bob"
    .replace(/[.,;:'"()]+$/, '');
}

export class GraphMemory {
  private entities = new Map<string, GraphEntity>();       // name (lowercased) → entity
  private entitiesById = new Map<string, GraphEntity>();   // id → entity
  private relations: GraphRelation[] = [];
  private config: Required<GraphMemoryConfig>;

  constructor(config: GraphMemoryConfig = {}) {
    this.config = {
      autoExtract: config.autoExtract ?? true,
      relationshipTypes: config.relationshipTypes ?? DEFAULT_RELATIONSHIP_TYPES,
      extractor: config.extractor!,
    };
  }

  // ── Extraction ──────────────────────────────────────────────────────────

  /**
   * Extract entities and relations from text.
   *
   * Rule-based: capitalised words are candidate entities; relation verbs are
   * matched between two entities in a sentence.
   */
  extract(content: string): ExtractionResult {
    const extractedEntities = new Map<string, GraphEntity>();
    const extractedRelations: GraphRelation[] = [];

    const sentences = content
      .split(/[.!?\n]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    for (const sentence of sentences) {
      // Capitalised-word entity detection (handles "Alice", "Project X", "ACME Corp")
      const words = sentence.split(/\s+/);
      const entitiesInSentence: string[] = [];

      for (let i = 0; i < words.length; i++) {
        const word = canonicalize(words[i]);
        if (/^[A-Z][A-Za-z0-9-]{1,}$/.test(word)) {
          entitiesInSentence.push(word);
          if (!extractedEntities.has(word)) {
            const now = Date.now();
            extractedEntities.set(word, {
              id: nextId('ent'),
              name: word,
              type: 'unknown',
              firstSeenAt: now,
              lastSeenAt: now,
              mentionCount: 0,
            });
          }
        }
      }

      // Relation extraction: find a relation verb between two entities
      if (entitiesInSentence.length >= 2) {
        const lower = sentence.toLowerCase();
        for (const [verb, relation] of Object.entries(RELATION_VERB_MAP)) {
          if (lower.includes(verb)) {
            // Link the first two entities in the sentence
            const from = entitiesInSentence[0];
            const to = entitiesInSentence[1];
            const fromEntity = this.ensureEntity(from);
            const toEntity = this.ensureEntity(to);
            extractedRelations.push({
              id: nextId('rel'),
              fromId: fromEntity.id,
              toId: toEntity.id,
              relation,
              createdAt: Date.now(),
            });
            break; // one relation per sentence (keeps it deterministic)
          }
        }
      }
    }

    // Merge extracted entities into the local set
    for (const [name, entity] of extractedEntities) {
      this.upsertEntity(name, entity);
    }
    this.relations.push(...extractedRelations);

    return {
      entities: [...extractedEntities.values()],
      relations: extractedRelations,
    };
  }

  // ── Store ───────────────────────────────────────────────────────────────

  /**
   * Store a memory, optionally auto-extracting entities/relations.
   */
  async store(content: string): Promise<ExtractionResult> {
    if (this.config.extractor) {
      const result = await this.config.extractor(content);
      for (const entity of result.entities) {
        this.upsertEntity(entity.name, entity);
      }
      this.relations.push(...result.relations);
      return result;
    }
    return this.extract(content);
  }

  // ── Traversal (multi-hop) ───────────────────────────────────────────────

  /**
   * Traverse the graph from a starting entity using breadth-first search.
   *
   * Returns all entities reachable within `maxHops`, each annotated with the
   * relation that led to it and its depth.
   */
  traverse(startName: string, options: { maxHops?: number } = {}): TraversalNode[] {
    const maxHops = options.maxHops ?? 2;
    const start = this.findEntity(startName);
    if (!start) return [];

    const visited = new Map<string, TraversalNode>([
      [start.id, { entity: start, depth: 0, relation: '', viaEntityId: null }],
    ]);

    let frontier = [start.id];
    for (let hop = 1; hop <= maxHops; hop++) {
      const next: string[] = [];
      for (const nodeId of frontier) {
        const neighbours = this.getNeighbours(nodeId);
        for (const { entity, relation, viaEntityId } of neighbours) {
          if (!visited.has(entity.id)) {
            visited.set(entity.id, { entity, depth: hop, relation, viaEntityId });
            next.push(entity.id);
          }
        }
      }
      frontier = next;
      if (frontier.length === 0) break;
    }

    return [...visited.values()];
  }

  /** Get entities directly connected to an entity, with the linking relation. */
  getNeighbours(entityId: string): Array<{ entity: GraphEntity; relation: string; viaEntityId: string }> {
    const results: Array<{ entity: GraphEntity; relation: string; viaEntityId: string }> = [];
    for (const rel of this.relations) {
      if (rel.fromId === entityId) {
        const entity = this.entitiesById.get(rel.toId);
        if (entity) results.push({ entity, relation: rel.relation, viaEntityId: rel.fromId });
      } else if (rel.toId === entityId) {
        const entity = this.entitiesById.get(rel.fromId);
        if (entity) results.push({ entity, relation: rel.relation, viaEntityId: rel.toId });
      }
    }
    return results;
  }

  // ── Lookups ─────────────────────────────────────────────────────────────

  findEntity(name: string): GraphEntity | null {
    return this.entities.get(canonicalize(name).toLowerCase()) ?? null;
  }

  getEntity(id: string): GraphEntity | null {
    return this.entitiesById.get(id) ?? null;
  }

  listEntities(): GraphEntity[] {
    return [...this.entities.values()];
  }

  listRelations(): GraphRelation[] {
    return [...this.relations];
  }

  stats(): GraphMemoryStats {
    return { entities: this.entities.size, relations: this.relations.length };
  }

  clear(): void {
    this.entities.clear();
    this.entitiesById.clear();
    this.relations = [];
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private ensureEntity(name: string): GraphEntity {
    const key = canonicalize(name).toLowerCase();
    const existing = this.entities.get(key);
    if (existing) return existing;
    const entity: GraphEntity = {
      id: nextId('ent'),
      name: canonicalize(name),
      type: 'unknown',
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
      mentionCount: 0,
    };
    this.entities.set(key, entity);
    this.entitiesById.set(entity.id, entity);
    return entity;
  }

  private upsertEntity(name: string, entity: GraphEntity): GraphEntity {
    const key = canonicalize(name).toLowerCase();
    const existing = this.entities.get(key);
    if (existing) {
      existing.lastSeenAt = Date.now();
      existing.mentionCount += 1;
      return existing;
    }
    this.entities.set(key, { ...entity, mentionCount: 1 });
    this.entitiesById.set(entity.id, this.entities.get(key)!);
    return this.entities.get(key)!;
  }
}
