export interface RateLimiter {
  hit(key: string): { allowed: boolean; retryAfterSec?: number };
  reset(key?: string): void;
}

interface Bucket {
  /** 窗口内每次命中的时间戳（毫秒）。 */
  hits: number[];
}

/**
 * 滑动窗口限流器：windowSec 内最多 max 次命中，用于登录（默认 5 次/分钟/IP）
 * 与 handoff redeem。命中被拒绝时返回 retryAfterSec，供 401 的 details 使用。
 *
 * 纯内存实现：进程重启后计数清零；core 是单写者，无需跨进程共享。
 */
export function createRateLimiter(opts: { windowSec: number; max: number }): RateLimiter {
  const windowMs = Math.max(1, opts.windowSec) * 1000;
  const max = Math.max(1, opts.max);
  const buckets = new Map<string, Bucket>();
  let lastSweep = 0;

  function prune(bucket: Bucket, now: number): void {
    const cutoff = now - windowMs;
    // 数组按时间升序，找到第一个未过期位置即可。
    let index = 0;
    while (index < bucket.hits.length && (bucket.hits[index] ?? 0) <= cutoff) index += 1;
    if (index > 0) bucket.hits.splice(0, index);
  }

  function sweep(now: number): void {
    if (now - lastSweep < windowMs) return;
    lastSweep = now;
    for (const [key, bucket] of buckets) {
      prune(bucket, now);
      if (bucket.hits.length === 0) buckets.delete(key);
    }
  }

  return {
    hit(key) {
      const now = Date.now();
      sweep(now);
      let bucket = buckets.get(key);
      if (bucket === undefined) {
        bucket = { hits: [] };
        buckets.set(key, bucket);
      }
      prune(bucket, now);
      if (bucket.hits.length >= max) {
        const oldest = bucket.hits[0] ?? now;
        const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
        return { allowed: false, retryAfterSec };
      }
      bucket.hits.push(now);
      return { allowed: true };
    },
    reset(key) {
      if (key === undefined) {
        buckets.clear();
        return;
      }
      buckets.delete(key);
    },
  };
}
