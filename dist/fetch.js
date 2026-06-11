import { createTokenManager } from "./token.js";
const DEFAULT_API_BASE = "https://open-api.guesty.com/v1";
export class GuestyApiError extends Error {
    status;
    body;
    path;
    constructor(status, body, path) {
        super(`Guesty API ${status} on ${path}: ${body.slice(0, 300)}`);
        this.status = status;
        this.body = body;
        this.path = path;
        this.name = "GuestyApiError";
    }
}
export function createGuestyClient(config) {
    const base = (config.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/$/, "");
    const tm = createTokenManager(config);
    const toUrl = (path) => /^https?:\/\//.test(path) ? path : `${base}/${path.replace(/^\//, "")}`;
    async function call(token, path, init) {
        const headers = new Headers(init?.headers);
        headers.set("Authorization", `Bearer ${token}`);
        if (init?.body && !headers.has("Content-Type")) {
            headers.set("Content-Type", "application/json");
        }
        return fetch(toUrl(path), { ...init, headers, cache: "no-store" });
    }
    async function guestyFetch(path, init) {
        let token = await tm.getAccessToken();
        let res = await call(token, path, init);
        if (res.status === 401) {
            await tm.invalidate();
            token = await tm.getAccessToken();
            res = await call(token, path, init);
        }
        return res;
    }
    async function guestyJson(path, init) {
        const res = await guestyFetch(path, init);
        if (!res.ok) {
            const body = await res.text().catch(() => "");
            throw new GuestyApiError(res.status, body, path);
        }
        return (await res.json());
    }
    return {
        getAccessToken: tm.getAccessToken,
        invalidate: tm.invalidate,
        guestyFetch,
        guestyJson,
    };
}
