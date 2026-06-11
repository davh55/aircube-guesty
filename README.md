# @aircube/guesty

Canonical Guesty Open API client for the Aircube apps. One source of truth for the
**OAuth token manager** (shared Redis cache + distributed lock + real `expires_in`)
and an authenticated `guestyFetch`. Kills the `guesty.ts` drift where 5 repos each
held their own copy (lock TTL had already diverged 10s vs 60s, fail-open vs
fail-closed).

Scope = the **shared, dangerous part** (token + lock + fetch). Each app keeps its
own API wrappers (getListing, getReservation…) and routes them through this client.

## Why a configurable client (not env-reading)

The apps disagree on env var names — aircube-web uses `KV_REST_API_*`, the others
`UPSTASH_REDIS_REST_*`. So the package never reads `process.env`; each app passes
its own creds.

## Usage

```ts
import { createGuestyClient } from "@aircube/guesty";

export const guesty = createGuestyClient({
  clientId: process.env.GUESTY_CLIENT_ID!,
  clientSecret: process.env.GUESTY_CLIENT_SECRET!,
  // aircube-web:
  redis: { url: process.env.KV_REST_API_URL!, token: process.env.KV_REST_API_TOKEN! },
  // others: { url: process.env.UPSTASH_REDIS_REST_URL!, token: process.env.UPSTASH_REDIS_REST_TOKEN! }
});

// authenticated calls (path relative to the v1 base, or absolute)
const listings = await guesty.guestyJson("/listings?limit=100");
const res = await guesty.guestyFetch(`/reservations/${id}`, { method: "PUT", body: JSON.stringify({ status: "canceled" }) });
```

All Aircube apps share ONE Redis (key `guesty:token`), which is what lets the 5
projects share a single daily token under Guesty's 5/day mint limit. **Keep the
same Redis instance + keys** when wiring each app.

## Reconciled behavior (best-of the 5 old copies)

- **60s lock** (was 10s in aircube-web + cleaning — expired mid-fetch, burned quota).
- **Fail-closed** lock: missing/unreachable Redis doesn't blindly mint; it polls for
  a peer's token first, last-resort mints only to avoid deadlock.
- **Real `expires_in`** (−60s safety margin) for the in-memory TTL, 1h fallback.
- In-memory + Redis (23h) cache; **401 retry** invalidates + re-mints once.
- Optional `manualToken` bypass.

## Build

```
npm install
npm run build   # tsc → dist/
```

Consumed as a git dependency:
`"@aircube/guesty": "github:davh55/aircube-guesty#main"`
