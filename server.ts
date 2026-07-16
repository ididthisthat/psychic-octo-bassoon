// Oxlo AI → OpenAI-compatible proxy with Postgres-backed account rotation.
// Auto-mints accounts via mail.tm, rotates on 429/daily-limit.

import { timingSafeEqual } from "node:crypto";
import { mintToken, accountIdFrom, tokenExpiry } from "./auth.ts";
import {
	initDb,
	listActive,
	listDead,
	loadActive,
	markError,
	markOk,
	moveDead,
	upsertAccount,
	type AccountRow,
	type DeadRow,
} from "./db.ts";
import { extractKey } from "./keys.ts";
import { startMintScheduler, startPeriodicReport } from "./mint-scheduler.ts";
import { pickAccount, type PickResult } from "./store.ts";
import { startTelegram } from "./telegram.ts";

const UPSTREAM = "https://api.oxlo.ai/v1/chat/completions";
const IMAGE_UPSTREAM = "https://api.oxlo.ai/v1/images/generations";
const PORT = Number(process.env.PORT ?? process.env.OXLO_PORT ?? 8761);
const HOST = process.env.OXLO_HOST ?? "127.0.0.1";
const PROXY_API_KEY = process.env.PROXY_API_KEY ?? "";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";
const MIN_POOL_SIZE = 3; // auto-mint when active accounts drop below this

// All free-tier models (verified working)
const MODELS = [
	"deepseek-v3.2",        // 671B — best code gen
	"deepseek-r1-8b",       // reasoning
	"gemma-3-4b",           // Google
	"llama-3.2-3b",         // Meta
	"mistral-7b",           // Mistral
	"stable-diffusion-1.5", // image gen
];

// OpenAI-compatible model list
const MODEL_LIST = {
	object: "list",
	data: MODELS.map((id) => {
		const m: Record<string, unknown> = { id, object: "model", owned_by: "oxlo-proxy" };
		if (id === "stable-diffusion-1.5") m.supports_images = true;
		return m;
	}),
};

const secretEq = (given: string, configured: string): boolean => {
	if (!configured) return false;
	const a = Buffer.from(given);
	const b = Buffer.from(configured);
	return a.length === b.length && timingSafeEqual(a, b);
};

const sendTo = (url: string) => (token: string, body: string) =>
	fetch(url, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body,
	});
const send = sendTo(UPSTREAM);
const sendImage = sendTo(IMAGE_UPSTREAM);

async function probe(token: string): Promise<number> {
	try {
		const res = await send(token, JSON.stringify({
			model: "deepseek-v3.2",
			messages: [{ role: "user", content: "hi" }],
			max_tokens: 1,
		}));
		return res.status;
	} catch {
		return 0;
	}
}

const ago = (d: Date | null): string => {
	if (!d) return "never";
	const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.round(s / 60)}m ago`;
	if (s < 86400) return `${Math.round(s / 3600)}h ago`;
	return `${Math.round(s / 86400)}d ago`;
};

const fmtActive = (rows: AccountRow[]): string =>
	rows.length === 0
		? "no active accounts"
		: rows.map((r) => `${r.id.slice(0, 12)}  ok:${ago(r.last_ok_at)}${r.last_error ? `  last-err:${r.last_error}` : ""}`).join("\n");

const fmtDead = (rows: DeadRow[]): string =>
	rows.length === 0
		? "no dead accounts"
		: rows.map((r) => `${r.id.slice(0, 12)}  ${r.reason}  ${ago(r.died_at)}`).join("\n");

if (import.meta.main) {
	await initDb();

	let tokens = await loadActive();
	let cursor = 0;
	const refresh = async (): Promise<void> => {
		tokens = await loadActive();
		if (cursor >= tokens.length) cursor = 0;
	};

	// Seed from OXLO_TOKENS env (one-time bootstrap; idempotent via dedup).
	if (process.env.OXLO_TOKENS) {
		for (const raw of process.env.OXLO_TOKENS.split(/[\n,]+/)) {
			const jwt = extractKey(raw);
			if (jwt) await upsertAccount(jwt);
		}
		await refresh();
	}


	const doMint = async (): Promise<{ added: boolean; id: string }> => {
		const jwt = await mintToken();
		const r = await upsertAccount(jwt);
		await refresh();
		return r;
	};
	// Throttled auto-mint: fire-and-forget, at most one mint in flight,
	// with a 3-5min random cooldown.
	let minting = false;
	let lastMintAt = 0;
	let cooldownMs = 240_000; // re-randomized after each mint
	const refillPool = async (): Promise<void> => {
		if (minting) return;
		const now = Date.now();
		if (now - lastMintAt < cooldownMs) return;
		if (tokens.length >= MIN_POOL_SIZE) return;
		minting = true;
		try {
			await doMint();
			lastMintAt = Date.now();
			cooldownMs = 180_000 + Math.floor(Math.random() * 120_000);
			console.log(`auto-minted: pool now ${tokens.length}`);
			bot?.notify(`Auto-minted new Oxlo account. Pool: ${tokens.length} active.`);
		} catch (e) {
			console.error("auto-mint failed:", e instanceof Error ? e.message : e);
		} finally {
			minting = false;
		}
	};

	const addRaw = async (raw: string): Promise<{ added: boolean; id: string }> => {
		const jwt = extractKey(raw);
		if (!jwt) throw new Error("no usable token in input");
		const r = await upsertAccount(jwt);
		await refresh();
		return r;
	};

	// Probe every active account, return "id  <status>" lines.
	const probeAll = async (): Promise<string> => {
		if (tokens.length === 0) return "no active accounts";
		const results = await Promise.all(tokens.map(async (t) => `${accountIdFrom(t).slice(0, 12)}  ${await probe(t)}`));
		return results.join("\n");
	};

	const bot = startTelegram({
		status: async () => `Oxlo proxy: ${tokens.length} active.\n${fmtActive(await listActive())}`,
		dead: async () => fmtDead(await listDead()),
		probe: probeAll,
		addToken: addRaw,
		mint: () => doMint(),
	});

	// Proactive scheduler: mint every 50-60 min, independent of request load.
	startMintScheduler(bot, async () => {
		await doMint();
		console.log(`scheduled-mint: pool now ${tokens.length}`);
		bot?.notify(`Scheduled mint: new Oxlo account. Pool: ${tokens.length} active.`);
	});

	// Periodic status push to Telegram every ~6h with jitter.
	if (bot) {
		startPeriodicReport(bot, async () =>
			`Oxlo proxy: ${tokens.length} active.\n${fmtActive(await listActive())}`);
	}

	const bookkeep = async (pick: PickResult): Promise<void> => {
		try {
			for (const d of pick.dead) {
				await moveDead(accountIdFrom(d.token), d.token, d.reason);
				bot?.notify(`Oxlo account ${accountIdFrom(d.token).slice(0, 12)} died: ${d.reason}`);
			}
			for (const s of pick.skipped) await markError(accountIdFrom(s.token), String(s.status));
			if (pick.res.status === 200) await markOk(accountIdFrom(pick.token));
			if (pick.dead.length > 0) await refresh();
			cursor = Math.max(0, tokens.indexOf(pick.token));
			if (tokens.length < MIN_POOL_SIZE) await refillPool();
		} catch (e) {
			console.error("pool bookkeeping failed:", e instanceof Error ? e.message : e);
		}
	};

	const server = Bun.serve({
		hostname: HOST,
		port: PORT,
		async fetch(req) {
			const { pathname } = new URL(req.url);

			if (pathname === "/health") {
				return Response.json({ ok: true, tokens: tokens.length, cursor });
			}

			if (pathname === "/v1/models" || pathname === "/models") {
				return Response.json(MODEL_LIST);
			}

			if (pathname.startsWith("/admin/")) {
				if (!secretEq(req.headers.get("x-admin-token") ?? "", ADMIN_TOKEN)) {
					return Response.json({ error: "forbidden" }, { status: 403 });
				}
				if (pathname === "/admin/accounts") {
					return Response.json({ active: await listActive(), cursor });
				}
				if (pathname === "/admin/dead") {
					return Response.json({ dead: await listDead() });
				}
				if (req.method === "POST" && pathname === "/admin/probe") {
					const results = await Promise.all(tokens.map(async (t) => ({ id: accountIdFrom(t), status: await probe(t) })));
					return Response.json({ probe: results });
				}
				if (req.method === "POST" && pathname === "/admin/add") {
					const { token } = await req.json();
					return Response.json(await addRaw(String(token ?? "")));
				}
				if (req.method === "POST" && pathname === "/admin/mint") {
					try {
						const jwt = await mintToken();
						const { added, id } = await upsertAccount(jwt);
						await refresh();
						const expiry = tokenExpiry(jwt);
						return Response.json({ added, id, expires: expiry?.toISOString() });
					} catch (e) {
						return Response.json({ error: `Mint failed: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 });
					}
				}
				return Response.json({ error: "unknown admin route" }, { status: 404 });
			}

			if (pathname === "/v1/images/generations" && req.method === "POST") {
				const key = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
				if (!secretEq(key, PROXY_API_KEY)) {
					return Response.json({ error: "invalid api key" }, { status: 401 });
				}
				if (tokens.length === 0) {
					void refillPool();
					const retry = String(lastMintAt > 0
						? Math.max(60, Math.ceil((lastMintAt + cooldownMs - Date.now()) / 1000))
						: 180);
					return Response.json(
						{ error: "No Oxlo accounts available." },
						{ status: 503, headers: { "Retry-After": retry } }
					);
				}
				const body = await req.text();
				const pick = await pickAccount(tokens, cursor, (t) => sendImage(t, body));

				void bookkeep(pick);

				if (pick.res.status !== 200) {
					bot?.notify(`Oxlo: all accounts unusable (HTTP ${pick.res.status}). Will auto-mint when cooldown expires.`);
				}
				return new Response(pick.res.body, {
					status: pick.res.status,
					headers: { "Content-Type": pick.res.headers.get("content-type") ?? "application/json" },
				});
			}

			if ((pathname === "/v1/chat/completions" || pathname === "/chat/completions") && req.method === "POST") {
				const key = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
				if (!secretEq(key, PROXY_API_KEY)) {
					return Response.json({ error: "invalid api key" }, { status: 401 });
				}
				if (tokens.length === 0) {
					void refillPool();
					const retry = String(lastMintAt > 0
						? Math.max(60, Math.ceil((lastMintAt + cooldownMs - Date.now()) / 1000))
						: 180);
					return Response.json(
						{ error: "No Oxlo accounts available." },
						{ status: 503, headers: { "Retry-After": retry } }
					);
				}
				const parsed = await req.json();
				if (parsed.model && !MODELS.includes(parsed.model)) {
					return Response.json({ error: `unknown model "${parsed.model}". Use one of: ${MODELS.join(", ")}` }, { status: 400 });
				}
				const body = JSON.stringify(parsed);
				const pick = await pickAccount(tokens, cursor, (t) => send(t, body));

				void bookkeep(pick);

				if (pick.res.status !== 200) {
					bot?.notify(`Oxlo: all accounts unusable (HTTP ${pick.res.status}). Will auto-mint when cooldown expires.`);
				}
				return new Response(pick.res.body, {
					status: pick.res.status,
					headers: { "Content-Type": pick.res.headers.get("content-type") ?? "application/json" },
				});
			}

			return Response.json({ error: "Use POST /v1/chat/completions or GET /v1/models." }, { status: 404 });
		},
	});

	console.log(`oxlo-proxy on http://${HOST}:${PORT}/v1  (${tokens.length} active${bot ? ", telegram on" : ""})`);

	process.on("SIGTERM", () => { server.stop(); process.exit(0); });
	process.on("SIGINT", () => { server.stop(); process.exit(0); });
}
