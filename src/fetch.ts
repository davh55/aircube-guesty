import { createTokenManager, type GuestyClientConfig } from "./token.js";

const DEFAULT_API_BASE = "https://open-api.guesty.com/v1";

export class GuestyApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly path: string,
  ) {
    super(`Guesty API ${status} on ${path}: ${body.slice(0, 300)}`);
    this.name = "GuestyApiError";
  }
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

export function createGuestyClient(
  config: GuestyClientConfig & { apiBaseUrl?: string },
): GuestyClient {
  const base = (config.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/$/, "");
  const tm = createTokenManager(config);

  const toUrl = (path: string): string =>
    /^https?:\/\//.test(path) ? path : `${base}/${path.replace(/^\//, "")}`;

  async function call(token: string, path: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    if (init?.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    return fetch(toUrl(path), { ...init, headers, cache: "no-store" });
  }

  async function guestyFetch(path: string, init?: RequestInit): Promise<Response> {
    let token = await tm.getAccessToken();
    let res = await call(token, path, init);
    if (res.status === 401) {
      await tm.invalidate();
      token = await tm.getAccessToken();
      res = await call(token, path, init);
    }
    return res;
  }

  async function guestyJson<T = unknown>(path: string, init?: RequestInit): Promise<T> {
    const res = await guestyFetch(path, init);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new GuestyApiError(res.status, body, path);
    }
    return (await res.json()) as T;
  }

  return {
    getAccessToken: tm.getAccessToken,
    invalidate: tm.invalidate,
    guestyFetch,
    guestyJson,
  };
}
