import type {
  Engram,
  MemoryStore,
  MemorySpaceConfig,
  Permission,
  TypedEmitter,
} from './types';

/**
 * A namespaced memory area with access control.
 * Supports cross-agent sharing with read/write/admin permissions.
 */
export class MemorySpace {
  readonly name: string;
  private config: MemorySpaceConfig;
  private consolidationTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: MemorySpaceConfig) {
    this.name = config.name;
    this.config = { ...config };
  }

  /** Check if an agent has a specific permission. */
  hasPermission(agentId: string, permission: Permission): boolean {
    const perms = this.config.acl[agentId];
    if (!perms) return false;
    if (perms.includes('admin')) return true;
    return perms.includes(permission);
  }

  /** Grant permissions to an agent. */
  grantAccess(agentId: string, permissions: Permission[]): void {
    this.config.acl[agentId] = [...new Set([
      ...(this.config.acl[agentId] ?? []),
      ...permissions,
    ])];
  }

  /** Revoke all permissions for an agent. */
  revokeAccess(agentId: string): void {
    delete this.config.acl[agentId];
  }

  /** Get all agents that have access to this space. */
  getAccessList(): Record<string, Permission[]> {
    return { ...this.config.acl };
  }

  /** Get all agent IDs with access. */
  getAgentIds(): string[] {
    return Object.keys(this.config.acl);
  }

  isShared(): boolean {
    return this.config.shared;
  }

  getMaxCapacity(): number {
    return this.config.maxCapacity;
  }

  getConfig(): Readonly<MemorySpaceConfig> {
    return { ...this.config };
  }

  destroy(): void {
    if (this.consolidationTimer) {
      clearInterval(this.consolidationTimer);
      this.consolidationTimer = null;
    }
  }
}

/**
 * Manages multiple memory spaces with cross-agent access control.
 * Handles conflict detection when multiple agents write to the same memory.
 */
export class MemorySpaceManager {
  private spaces = new Map<string, MemorySpace>();
  private store: MemoryStore;
  private emitter: TypedEmitter;
  /** Tracks recent writers to each engram for conflict detection: engramId → agentId[] */
  private writeTracking = new Map<string, { agents: Set<string>; lastWrite: number }>();
  private conflictWindow: number;

  constructor(store: MemoryStore, emitter: TypedEmitter, conflictWindowMs: number = 5000) {
    this.store = store;
    this.emitter = emitter;
    this.conflictWindow = conflictWindowMs;
  }

  /** Create a new memory space. */
  createSpace(config: MemorySpaceConfig): MemorySpace {
    if (this.spaces.has(config.name)) {
      throw new Error(`Memory space '${config.name}' already exists`);
    }

    const space = new MemorySpace(config);
    this.spaces.set(config.name, space);
    this.emitter.emit('space:created', config.name);
    return space;
  }

  /** Get a memory space by name. */
  getSpace(name: string): MemorySpace | null {
    return this.spaces.get(name) ?? null;
  }

  /** List all spaces. */
  listSpaces(): MemorySpace[] {
    return [...this.spaces.values()];
  }

  /** List spaces an agent has access to. */
  listAgentSpaces(agentId: string): MemorySpace[] {
    return [...this.spaces.values()].filter(s =>
      s.hasPermission(agentId, 'read'),
    );
  }

  /**
   * Validate that an agent can perform an operation in a namespace.
   * Throws if the agent lacks permission.
   */
  assertPermission(namespace: string, agentId: string, permission: Permission): void {
    const space = this.spaces.get(namespace);
    if (!space) {
      // Default namespace is always accessible
      if (namespace === 'default') return;
      throw new Error(`Memory space '${namespace}' does not exist`);
    }
    if (!space.hasPermission(agentId, permission)) {
      throw new Error(
        `Agent '${agentId}' does not have '${permission}' permission on space '${namespace}'`,
      );
    }
  }

  /**
   * Check capacity before writing to a space.
   * Emits warning when approaching capacity.
   */
  async checkCapacity(namespace: string): Promise<boolean> {
    const space = this.spaces.get(namespace);
    if (!space || space.getMaxCapacity() === 0) return true;

    const count = await this.store.count({ namespace, status: 'active' });
    const capacity = space.getMaxCapacity();

    if (count >= capacity) return false;

    if (count >= capacity * 0.9) {
      this.emitter.emit('space:capacity-warning', namespace, count, capacity);
    }

    return true;
  }

  /**
   * Track a write operation for conflict detection.
   * If multiple agents write to the same engram within the conflict window,
   * emit a conflict event.
   */
  trackWrite(engramId: string, agentId: string): void {
    const now = Date.now();
    let tracking = this.writeTracking.get(engramId);

    if (!tracking || (now - tracking.lastWrite) > this.conflictWindow) {
      tracking = { agents: new Set(), lastWrite: now };
      this.writeTracking.set(engramId, tracking);
    }

    tracking.agents.add(agentId);
    tracking.lastWrite = now;

    if (tracking.agents.size > 1) {
      this.emitter.emit('memory:conflict', engramId, [...tracking.agents]);
    }
  }

  /** Remove a space and clean up. */
  removeSpace(name: string): boolean {
    const space = this.spaces.get(name);
    if (!space) return false;
    space.destroy();
    this.spaces.delete(name);
    return true;
  }

  destroy(): void {
    for (const space of this.spaces.values()) {
      space.destroy();
    }
    this.spaces.clear();
    this.writeTracking.clear();
  }
}
