import { Redis } from "@upstash/redis";

export interface GuestyClientConfig {
  /** Guesty OAuth2 client credentials. */
  clientId: string;
  clientSecret: string;
  /**
   * Upstash Redis for the shared token cache + distributed lock. Pass a Redis
   * instance, REST creds, or null. Without Redis there is no cross-process
   * coordination, so the 5/day mint limit is NOT protected — only use null for
   * local/dev. The Aircube apps share ONE Redis (key "guesty:token"), which is
   * what lets 5 projects share a single daily token.
   */
  redis?: Redis | { url: string; token: string } | null;
  /** Bypass: if set, always use this token (e.g. a long-lived manual token). */
  manualToken?: string;
  /** OAuth token endpoint. Default Guesty Open API. */
  tokenUrl?: string;
  /** Redis keys. Defaults match every existing Aircube app (do not change lightly). */
  redisKey?: string;
  lockKey?: string;
}

const DEFAULT_TOKEN_URL = "https://open-api.guesty.com/oauth2/token";
const REDIS_TTL_SEC = 82_800; // 23h — a Guesty token lives 24h; refresh before.
// 60s lock (NOT 10s): a 10s TTL expired mid-fetch and let the sister projects mint
// concurrent tokens, burning Guesty's 5/day quota. This is the proven value.
const LOCK_TTL_SEC = 60;
const DEFAULT_TTL_MS = 3_600_000; // 1h fallback if expires_in is missing
const SAFETY_MARGIN_MS = 60_000; // refresh 60s before the real expiry
const LOCK_POLL_TRIES = 5;
const LOCK_POLL_DELAY_MS = 400;

interface OAuthResponse {
  access_token?: string;
  expires_in?: number;
}

function toRedis(redis: GuestyClientConfig["redis"]): Redis | null {
  if (!redis) return null;
  if (redis instanceof Redis) return redis;
  if (typeof redis === "object" && "url" in redis && "token" in redis) {
    return new Redis({ url: redis.url, token: redis.token });
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Build a token manager bound to one app's config. Each app constructs this with
 * its OWN env mapping (aircube-web uses KV_REST_API_*, the others UPSTASH_*), so
 * the package never reads process.env itself.
 */
export function createTokenManager(config: GuestyClientConfig) {
  const tokenUrl = config.tokenUrl ?? DEFAULT_TOKEN_URL;
  const redisKey = config.redisKey ?? "guesty:token";
  const lockKey = config.lockKey ?? "guesty:token:lock";
  const redis = toRedis(config.redis);

  // Per-instance in-memory cache: avoids a Redis round-trip on hot paths.
  let memory: { token: string; expires: number } | null = null;

  async function readCache(): Promise<string | null> {
    if (!redis) return null;
    try {
      const cached = await redis.get<string>(redisKey);
      return typeof cached === "string" && cached.length > 0 ? cached : null;
    } catch {
      return null;
    }
  }

  /** Fail-CLOSED: missing/unreachable Redis returns false (do NOT mint blindly). */
  async function acquireLock(): Promise<boolean> {
    if (!redis) return false;
    try {
      const res = await redis.set(lockKey, "1", { nx: true, ex: LOCK_TTL_SEC });
      return res === "OK";
    } catch {
      return false;
    }
  }

  async function releaseLock(): Promise<void> {
    if (!redis) return;
    try {
      await redis.del(lockKey);
    } catch {
      /* lock self-expires via TTL */
    }
  }

  async function mint(): Promise<string> {
    // Retry on 429 (Guesty's mint endpoint is rate-limited at 5/day; a transient
    // 429 under contention should back off, not hard-fail).
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: config.clientId,
          client_secret: config.clientSecret,
          scope: "open-api",
        }),
        cache: "no-store",
      });

      if (res.status === 429 && attempt < 2) {
        await sleep(Math.min(2 ** attempt * 5000, 30_000));
        continue;
      }
      if (!res.ok) {
        throw new Error(`Guesty token request failed: ${res.status}`);
      }

      const data = (await res.json()) as OAuthResponse;
      const token = data.access_token;
      if (!token) throw new Error("Guesty token response missing access_token");

      // Use the REAL expires_in (minus a safety margin) for the in-memory TTL;
      // fall back to 1h if Guesty omits it.
      const ttlMs =
        typeof data.expires_in === "number" && data.expires_in > 0
          ? data.expires_in * 1000 - SAFETY_MARGIN_MS
          : DEFAULT_TTL_MS;
      memory = { token, expires: Date.now() + Math.max(0, ttlMs) };
      if (redis) {
        try {
          await redis.set(redisKey, token, { ex: REDIS_TTL_SEC });
        } catch {
          /* in-memory copy still serves this process */
        }
      }
      return token;
    }
    throw new Error("Guesty token request rate-limited (429) after 3 attempts");
  }

  async function getAccessToken(): Promise<string> {
    // 1. Manual bypass.
    if (config.manualToken) return config.manualToken;

    // 2. In-memory cache.
    if (memory && memory.expires > Date.now()) return memory.token;

    // 3. Shared Redis cache.
    const cached = await readCache();
    if (cached) {
      memory = { token: cached, expires: Date.now() + DEFAULT_TTL_MS };
      return cached;
    }

    // 4. No Redis at all → can't coordinate, mint directly (single-process/dev).
    if (!redis) return mint();

    // 5. Distributed lock so only ONE process mints (protects the 5/day quota).
    const locked = await acquireLock();
    if (!locked) {
      // A sibling is minting. Poll for the token it writes instead of minting too.
      for (let i = 0; i < LOCK_POLL_TRIES; i++) {
        await sleep(LOCK_POLL_DELAY_MS);
        const peer = await readCache();
        if (peer) {
          memory = { token: peer, expires: Date.now() + DEFAULT_TTL_MS };
          return peer;
        }
      }
      // Last resort to avoid a deadlock if the lock holder died before writing.
      console.warn("[guesty] lock contended and no peer token appeared — minting anyway");
      return mint();
    }
    try {
      // Re-check the cache: a peer may have written between our miss and the lock.
      const fresh = await readCache();
      if (fresh) {
        memory = { token: fresh, expires: Date.now() + DEFAULT_TTL_MS };
        return fresh;
      }
      return await mint();
    } finally {
      await releaseLock();
    }
  }

  /** Drop the cached token (in-memory + Redis) after a 401, so the next call mints. */
  async function invalidate(): Promise<void> {
    memory = null;
    if (redis) {
      try {
        await redis.del(redisKey);
      } catch {
        /* will be overwritten on next mint */
      }
    }
  }

  return { getAccessToken, invalidate };
}

export type TokenManager = ReturnType<typeof createTokenManager>;
