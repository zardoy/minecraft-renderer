/**
 * Topology-keyed cache for the per-section visGraph + block-entity post-pass.
 *
 * Wave-2 covering remeshes carry the same `topologyRevision` as wave-1, so the
 * 4096-cell walk can be reused. A new revision always recomputes. Legacy /
 * unversioned jobs (no revision) never cache.
 */

export const TOPOLOGY_POST_CACHE_LIMIT = 1024

export type TopologyPostPayload = {
  visibilitySet: unknown
  signs: Record<string, unknown>
  heads: Record<string, unknown>
  banners: Record<string, unknown>
}

type CacheEntry = {
  topologyRevision: number
  payload: TopologyPostPayload
}

const cache = new Map<string, CacheEntry>()

export function getOrComputeTopologyPost<T extends TopologyPostPayload>(
  key: string,
  topologyRevision: number | undefined,
  compute: () => T
): { payload: T; hit: boolean } {
  if (topologyRevision == null) {
    return { payload: compute(), hit: false }
  }
  const existing = cache.get(key)
  if (existing && existing.topologyRevision === topologyRevision) {
    cache.delete(key)
    cache.set(key, existing)
    return { payload: existing.payload as T, hit: true }
  }
  const payload = compute()
  cache.set(key, { topologyRevision, payload })
  evictIfNeeded()
  return { payload, hit: false }
}

export function clearTopologyPostCacheColumn(x: number, z: number): void {
  for (const key of [...cache.keys()]) {
    const [sx, , sz] = key.split(',').map(Number)
    if (sx === x && sz === z) cache.delete(key)
  }
}

export function clearTopologyPostCache(): void {
  cache.clear()
}

function evictIfNeeded(): void {
  while (cache.size > TOPOLOGY_POST_CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest == null) break
    cache.delete(oldest)
  }
}
