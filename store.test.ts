import assert from "node:assert";
import { pickAccount } from "./store.ts";

const send = (statusByToken: Record<string, number>) => (t: string) =>
	Promise.resolve(new Response("", { status: statusByToken[t] ?? 200 }));

const sendBody = (map: Record<string, { status: number; body?: string }>) => (t: string) =>
	Promise.resolve(new Response(map[t]?.body ?? "", { status: map[t]?.status ?? 200 }));

// healthy first token wins, nothing dead or skipped
let r = await pickAccount(["a", "b", "c"], 0, send({}));
assert.equal(r.token, "a");
assert.deepEqual(r.dead, []);
assert.deepEqual(r.skipped, []);

// rotate past a 429 (rate-limited) — skipped, not dead
r = await pickAccount(["a", "b", "c"], 0, send({ a: 429 }));
assert.equal(r.token, "b");
assert.deepEqual(r.dead, []);
assert.deepEqual(r.skipped, [{ token: "a", status: 429 }]);

// wrap around from a non-zero start
r = await pickAccount(["a", "b", "c"], 2, send({ c: 429, a: 429 }));
assert.equal(r.token, "b");

// all rate-limited → last tried, still 429, both skipped
r = await pickAccount(["a", "b"], 0, send({ a: 429, b: 429 }));
assert.equal(r.res.status, 429);
assert.deepEqual(r.skipped, [
	{ token: "a", status: 429 },
	{ token: "b", status: 429 },
]);

// 401 = invalid → dead
r = await pickAccount(["a", "b", "c"], 0, send({ a: 401, b: 429 }));
assert.equal(r.token, "c");
assert.deepEqual(r.dead, [{ token: "a", reason: "invalid_401" }]);
assert.deepEqual(r.skipped, [{ token: "b", status: 429 }]);

// 403 = invalid → dead (same as 401)
r = await pickAccount(["a", "b"], 0, send({ a: 403 }));
assert.equal(r.token, "b");
assert.deepEqual(r.dead, [{ token: "a", reason: "invalid_401" }]);

// 402 = exhausted → dead
r = await pickAccount(["a", "b"], 0, send({ a: 402 }));
assert.equal(r.token, "b");
assert.deepEqual(r.dead, [{ token: "a", reason: "exhausted" }]);

// 429 with "daily_limit" text → dead (exhausted)
r = await pickAccount(["a", "b"], 0, sendBody({ a: { status: 429, body: '{"error":"daily_limit reached"}' } }));
assert.equal(r.token, "b");
assert.deepEqual(r.dead, [{ token: "a", reason: "exhausted" }]);

// 429 with "daily limit" text → dead (exhausted)
r = await pickAccount(["a", "b"], 0, sendBody({ a: { status: 429, body: "Your daily limit has been exceeded." } }));
assert.equal(r.token, "b");
assert.deepEqual(r.dead, [{ token: "a", reason: "exhausted" }]);

// 5xx (transient upstream) → skip to next, keep the token
r = await pickAccount(["a", "b", "c"], 0, send({ a: 503, b: 502 }));
assert.equal(r.token, "c");
assert.deepEqual(r.dead, []);
assert.deepEqual(r.skipped, [
	{ token: "a", status: 503 },
	{ token: "b", status: 502 },
]);

// all transient-failing → surface the last, nothing dropped
r = await pickAccount(["a", "b"], 0, send({ a: 500, b: 502 }));
assert.equal(r.res.status, 502);
assert.deepEqual(r.dead, []);

// all dead → last response surfaced, all in dead
r = await pickAccount(["a", "b"], 0, send({ a: 401, b: 402 }));
assert.equal(r.res.status, 402);
assert.equal(r.dead.length, 2);
assert.deepEqual(r.skipped, []);

console.log("ok");
