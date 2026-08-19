interface LRUCacheEntry<V> {
  value: V;
  expiresAt: number;
}

/**
 * Bounded, TTL'd, least-recently-used eviction — shared by every in-process
 * cache across `@workspace/lookup` (moved here from lookup.ts, which had its
 * own copy plus a second, unbounded `Map` for `prefixAsnCache` that grew
 * without limit; both now use this one implementation). "Cap it" is a
 * constructor argument here, not a decision that can be separately missed
 * per cache.
 */
export class LRUCache<V> {
  private map = new Map<string, LRUCacheEntry<V>>();
  hits = 0;
  misses = 0;

  constructor(
    private readonly maxSize: number,
    private readonly ttlMs: number,
  ) {}

  get(key: string): V | null {
    const entry = this.map.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }
    if (entry.expiresAt < Date.now()) {
      this.map.delete(key);
      this.misses++;
      return null;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits++;
    return entry.value;
  }

  set(key: string, value: V): void {
    if (this.map.size >= this.maxSize) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) this.map.delete(oldestKey);
    }
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  clear(): void {
    this.map.clear();
  }

  stats(): { size: number; hits: number; misses: number; hitRatio: number } {
    const total = this.hits + this.misses;
    return {
      size: this.map.size,
      hits: this.hits,
      misses: this.misses,
      hitRatio: total === 0 ? 0 : this.hits / total,
    };
  }
}
