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
    redis?: Redis | {
        url: string;
        token: string;
    } | null;
    /** Bypass: if set, always use this token (e.g. a long-lived manual token). */
    manualToken?: string;
    /** OAuth token endpoint. Default Guesty Open API. */
    tokenUrl?: string;
    /** Redis keys. Defaults match every existing Aircube app (do not change lightly). */
    redisKey?: string;
    lockKey?: string;
}
/**
 * Build a token manager bound to one app's config. Each app constructs this with
 * its OWN env mapping (aircube-web uses KV_REST_API_*, the others UPSTASH_*), so
 * the package never reads process.env itself.
 */
export declare function createTokenManager(config: GuestyClientConfig): {
    getAccessToken: () => Promise<string>;
    invalidate: () => Promise<void>;
};
export type TokenManager = ReturnType<typeof createTokenManager>;
