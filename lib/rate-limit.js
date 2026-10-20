// Fixed-window limiter kept in memory. Enough for a single instance; counts reset on restart.
export function createRateLimiter({ limit, windowMs, now = Date.now }) {
  const hits = new Map();
  return function allow(key) {
    const time = now();
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= time) {
      if (hits.size > 10_000) {
        for (const [oldKey, old] of hits) if (old.resetAt <= time) hits.delete(oldKey);
      }
      hits.set(key, { count: 1, resetAt: time + windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  };
}
