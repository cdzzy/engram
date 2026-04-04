/**
 * Engram — Multi-Agent Long-Term Memory Example
 *
 * Scenario: A research team of 3 agents shares a knowledge base.
 *   - Researcher: discovers and stores facts
 *   - Analyst: reviews, updates, and supersedes outdated facts
 *   - Writer: reads from shared memory to produce summaries
 *
 * Demonstrates:
 *   1. Shared memory space with ACL
 *   2. Forgetting curve decay and reinforcement
 *   3. Memory versioning and supersession
 *   4. Multi-signal recall
 *   5. Automatic consolidation of weak memories
 */

import { MemoryManager } from '../src';

async function main() {
  // ── 1. Initialize ────────────────────────────────────────────────────────

  const mm = new MemoryManager({
    decay: {
      baseHalfLife: 60_000,  // 1 minute for demo purposes
    },
    defaultNamespace: 'default',
  });

  // Create a shared knowledge base
  mm.createSpace({
    name: 'team-kb',
    maxCapacity: 1000,
    acl: {
      'researcher': ['read', 'write', 'admin'],
      'analyst': ['read', 'write'],
      'writer': ['read'],
    },
    shared: true,
    consolidationInterval: 0,
  });

  // Listen for events
  mm.emitter.on('memory:encoded', (e) => {
    console.log(`  [encoded] "${e.content.slice(0, 50)}..." by ${e.source}`);
  });

  mm.emitter.on('memory:superseded', (old, _new) => {
    console.log(`  [superseded] "${old.content.slice(0, 40)}..." → "${_new.content.slice(0, 40)}..."`);
  });

  mm.emitter.on('memory:conflict', (_id, agents) => {
    console.log(`  [conflict] Concurrent writes detected from: ${agents.join(', ')}`);
  });

  mm.emitter.on('memory:compressed', (result) => {
    console.log(`  [compressed] ${result.sourceIds.length} memories → 1 summary`);
  });

  // ── 2. Researcher stores discoveries ─────────────────────────────────────

  console.log('\n=== Phase 1: Researcher stores facts ===');

  const fact1 = await mm.encode({
    content: 'GPT-4 was released in March 2023 with multimodal capabilities',
    type: 'semantic',
    source: 'researcher',
    namespace: 'team-kb',
    tags: ['ai', 'gpt', 'releases'],
    importance: 'high',
  });

  const fact2 = await mm.encode({
    content: 'Claude 2 launched in July 2023 with 100K context window',
    type: 'semantic',
    source: 'researcher',
    namespace: 'team-kb',
    tags: ['ai', 'claude', 'releases'],
    importance: 'high',
  });

  await mm.encode({
    content: 'Llama 2 was open-sourced by Meta in July 2023',
    type: 'semantic',
    source: 'researcher',
    namespace: 'team-kb',
    tags: ['ai', 'open-source', 'releases'],
    importance: 'medium',
  });

  // Store some daily notes (these will decay faster)
  for (let i = 1; i <= 5; i++) {
    await mm.encode({
      content: `Research session ${i}: Reviewed ${i * 3} papers on agent architectures`,
      type: 'episodic',
      source: 'researcher',
      namespace: 'team-kb',
      tags: ['daily-notes', 'research'],
      importance: 'low',
    });
  }

  // ── 3. Analyst reviews and updates ───────────────────────────────────────

  console.log('\n=== Phase 2: Analyst updates knowledge ===');

  // Update a fact with new information
  await mm.update(fact1.id, 'GPT-4 released March 2023 — supports text and image input, scored 90th percentile on bar exam', 'analyst');
  console.log('  Updated GPT-4 fact with bar exam score');

  // Supersede an outdated fact
  const { new: updatedClaude } = await mm.supersede(fact2.id, {
    content: 'Claude 3.5 Sonnet released June 2024 with 200K context, outperforms GPT-4 on many benchmarks',
    type: 'semantic',
    source: 'analyst',
    namespace: 'team-kb',
    tags: ['ai', 'claude', 'releases'],
    importance: 'high',
  });

  // Verify supersession chain
  const latest = await mm.resolveLatest(fact2.id);
  console.log(`  Supersession chain: "${fact2.content.slice(0, 30)}..." → "${latest!.content.slice(0, 30)}..."`);

  // Check version history
  const history = mm.getVersionHistory(fact1.id);
  console.log(`  GPT-4 fact has ${history.length} versions`);

  // ── 4. Writer queries shared memory ──────────────────────────────────────

  console.log('\n=== Phase 3: Writer queries memory ===');

  const aiResults = await mm.query({
    text: 'AI model releases',
    namespace: 'team-kb',
    limit: 5,
    reinforce: true,  // Accessed memories get stronger
    recencyBias: 0.3,
    strengthBias: 0.3,
    relevanceBias: 0.25,
    importanceBias: 0.15,
  });

  console.log(`  Found ${aiResults.length} relevant memories:`);
  for (const r of aiResults) {
    console.log(`    [score=${r.score.toFixed(3)}] ${r.engram.content.slice(0, 60)}...`);
  }

  // Writer tries to write (should fail — read-only)
  try {
    await mm.encode({
      content: 'should not work',
      type: 'episodic',
      source: 'writer',
      namespace: 'team-kb',
    });
  } catch (err: any) {
    console.log(`  Writer write blocked: ${err.message}`);
  }

  // ── 5. Decay and consolidation ───────────────────────────────────────────

  console.log('\n=== Phase 4: Memory lifecycle ===');

  // Simulate time passing — weaken the daily notes
  const dailyNotes = await mm.store.query({
    namespace: 'team-kb',
    tags: ['daily-notes'],
    status: 'active',
  });

  for (const note of dailyNotes) {
    await mm.store.put({ ...note, strength: 0.15 });
  }

  // Run consolidation — should compress weak daily notes into a summary
  const compressionResults = await mm.consolidate({
    namespace: 'team-kb',
    maxStrength: 0.3,
    minGroupSize: 3,
  });

  if (compressionResults.length > 0) {
    console.log(`  Consolidated ${compressionResults[0].sourceIds.length} daily notes into summary:`);
    console.log(`    "${compressionResults[0].compressed.content.slice(0, 80)}..."`);
  }

  // ── 6. Stats ─────────────────────────────────────────────────────────────

  console.log('\n=== Memory Statistics ===');
  const stats = await mm.stats('team-kb');
  console.log(`  Total: ${stats.total}`);
  console.log(`  Active: ${stats.active}`);
  console.log(`  Compressed: ${stats.compressed}`);
  console.log(`  Superseded: ${stats.superseded}`);

  // Peek at decay predictions
  console.log('\n=== Decay Predictions ===');
  const claudeFact = await mm.get(updatedClaude.id);
  if (claudeFact) {
    const decayTime = mm.predictDecayTime(claudeFact, 0.5);
    console.log(`  Claude fact will drop to 50% strength in ${(decayTime / 60000).toFixed(1)} minutes`);
  }

  mm.stop();
  console.log('\nDone.');
}

main().catch(console.error);
