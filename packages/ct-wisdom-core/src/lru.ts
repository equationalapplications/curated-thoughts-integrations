/**
 * lru.ts — the one LRU helper every bounded cache in the core and its hosts
 * uses: insertion order is recency (a set moves the key to the end), and
 * the oldest entries are evicted past `max`.
 */

/** Set `key` to `value` as the most recent entry; evict the oldest past `max`. */
export function lruSet<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

/** Read `key` and mark it most recent (undefined when absent). */
export function lruGet<K, V>(map: Map<K, V>, key: K): V | undefined {
  if (!map.has(key)) return undefined;
  const value = map.get(key) as V;
  map.delete(key);
  map.set(key, value);
  return value;
}
