import { type GuestyClientConfig } from "./token.js";
export declare class GuestyApiError extends Error {
    readonly status: number;
    readonly body: string;
    readonly path: string;
    constructor(status: number, body: string, path: string);
}
export interface GuestyClient {
    /** The reconciled token manager (Redis cache + 60s lock + real expires_in). */
    getAccessToken(): Promise<string>;
    /** Drop the cached token (used internally on 401; rarely needed directly). */
    invalidate(): Promise<void>;
    /**
     * Authenticated fetch. `path` is relative to the v1 base ("/listings") or an
     * absolute URL. Retries ONCE on 401 (stale token → invalidate → re-mint).
     */
    guestyFetch(path: string, init?: RequestInit): Promise<Response>;
    /** guestyFetch + JSON; throws GuestyApiError (with the response body) on non-2xx. */
    guestyJson<T = unknown>(path: string, init?: RequestInit): Promise<T>;
}
export declare function createGuestyClient(config: GuestyClientConfig & {
    apiBaseUrl?: string;
}): GuestyClient;
