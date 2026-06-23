import { Redis } from "@upstash/redis";
const DEFAULT_TOKEN_URL = "https://open-api.guesty.com/oauth2/token";
const REDIS_TTL_SEC = 82_800; // 23h — a Guesty token lives 24h; refresh before.
// 60s lock (NOT 10s): a 10s TTL expired mid-fetch and let the sister projects mint
// concurrent tokens, burning Guesty's 5/day quota. This is the proven value.
const LOCK_TTL_SEC = 60;
const DEFAULT_TTL_MS = 3_600_000; // 1h fallback if expires_in is missing
const SAFETY_MARGIN_MS = 60_000; // refresh 60s before the real expiry
const LOCK_POLL_TRIES = 5;
const LOCK_POLL_DELAY_MS = 400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * Build a token manager bound to one app's config. Each app constructs this with
 * its OWN env mapping (aircube-web uses KV_REST_API_*, the others UPSTASH_*), so
 * the package never reads process.env itself.
 */
export function createTokenManager(config) {
    const tokenUrl = config.tokenUrl ?? DEFAULT_TOKEN_URL;
    const redisKey = config.redisKey ?? "guesty:token";
    const lockKey = config.lockKey ?? "guesty:token:lock";
    // Redis is built LAZILY (never at import/module-init): constructing
    // @upstash/redis eagerly throws on a malformed URL, which would crash a Next
    // build that merely imports this module. Built once on first use, defensively
    // (trim whitespace/newlines from env values, swallow construction errors →
    // degrade to no-Redis rather than throw).
    let redisResolved = false;
    let redisClient = null;
    function getRedis() {
        if (redisResolved)
            return redisClient;
        redisResolved = true;
        const r = config.redis;
        try {
            if (!r) {
                redisClient = null;
            }
            else if (r instanceof Redis) {
                redisClient = r;
            }
            else if (typeof r === "object" && "url" in r && "token" in r) {
                const url = String(r.url ?? "").trim();
                const token = String(r.token ?? "").trim();
                redisClient = url && token ? new Redis({ url, token }) : null;
            }
        }
        catch {
            redisClient = null;
        }
        return redisClient;
    }
    // Per-instance in-memory cache: avoids a Redis round-trip on hot paths.
    let memory = null;
    async function readCache() {
        const redis = getRedis();
        if (!redis)
            return null;
        try {
            const cached = await redis.get(redisKey);
            return typeof cached === "string" && cached.length > 0 ? cached : null;
        }
        catch {
            return null;
        }
    }
    /** Fail-CLOSED: missing/unreachable Redis returns false (do NOT mint blindly). */
    async function acquireLock() {
        const redis = getRedis();
        if (!redis)
            return false;
        try {
            const res = await redis.set(lockKey, "1", { nx: true, ex: LOCK_TTL_SEC });
            return res === "OK";
        }
        catch {
            return false;
        }
    }
    async function releaseLock() {
        const redis = getRedis();
        if (!redis)
            return;
        try {
            await redis.del(lockKey);
        }
        catch {
            /* lock self-expires via TTL */
        }
    }
    async function mint() {
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
            const data = (await res.json());
            const token = data.access_token;
            if (!token)
                throw new Error("Guesty token response missing access_token");
            // Use the REAL expires_in (minus a safety margin) for the in-memory TTL;
            // fall back to 1h if Guesty omits it.
            const ttlMs = typeof data.expires_in === "number" && data.expires_in > 0
                ? data.expires_in * 1000 - SAFETY_MARGIN_MS
                : DEFAULT_TTL_MS;
            memory = { token, expires: Date.now() + Math.max(0, ttlMs) };
            const redis = getRedis();
            if (redis) {
                try {
                    await redis.set(redisKey, token, { ex: REDIS_TTL_SEC });
                }
                catch {
                    /* in-memory copy still serves this process */
                }
                // Observability: count mints/day in a SHARED key (every Aircube app +
                // aircube-web's own client increment the same key), so approaching
                // Guesty's ~5/day cap is visible to a monitor cron. Best-effort — never
                // blocks token issuance. Self-expires after 2 days.
                try {
                    const k = `guesty:mint:${new Date().toISOString().slice(0, 10)}`;
                    await redis.incr(k);
                    await redis.expire(k, 172_800);
                }
                catch {
                    /* counting is best-effort */
                }
            }
            return token;
        }
        throw new Error("Guesty token request rate-limited (429) after 3 attempts");
    }
    async function getAccessToken() {
        // 1. Manual bypass.
        if (config.manualToken)
            return config.manualToken;
        // 2. In-memory cache.
        if (memory && memory.expires > Date.now())
            return memory.token;
        // 3. Shared Redis cache.
        const cached = await readCache();
        if (cached) {
            memory = { token: cached, expires: Date.now() + DEFAULT_TTL_MS };
            return cached;
        }
        // 4. No Redis at all → can't coordinate, mint directly (single-process/dev).
        if (!getRedis())
            return mint();
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
        }
        finally {
            await releaseLock();
        }
    }
    /** Drop the cached token (in-memory + Redis) after a 401, so the next call mints. */
    async function invalidate() {
        memory = null;
        const redis = getRedis();
        if (redis) {
            try {
                await redis.del(redisKey);
            }
            catch {
                /* will be overwritten on next mint */
            }
        }
    }
    return { getAccessToken, invalidate };
}
