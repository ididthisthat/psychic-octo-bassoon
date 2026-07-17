// Token rotation for Oxlo. 429 (rate-limited) → skip to next account.
// Token expiry within 24h → move to dead. 401/403 → move to dead.

import type { DeadReason } from "./db.ts"; // type-only: erased, never runs db.ts
export type Dead = { token: string; reason: DeadReason };
export type Skipped = { token: string; status: number };
export type PickResult = {
	token: string;
	res: Response;
	dead: Dead[];
	skipped: Skipped[];
};

const rebuild = (status: number, text: string, contentType: string | null): Response =>
	new Response(text, { status, headers: { "Content-Type": contentType ?? "application/json" } });

// Check if JWT expires within threshold
function expiresSoon(token: string, hoursThreshold = 24): boolean {
	try {
		const payload = JSON.parse(
			Buffer.from(token.split(".")[1], "base64url").toString()
		);
		if (payload.exp) {
			const remaining = payload.exp - Date.now() / 1000;
			return remaining < hoursThreshold * 3600;
		}
	} catch {}
	return false;
}

// Try tokens from `startAt`, wrapping. A 200 wins immediately.
// 429 → skipped (rate-limited, try next account).
// 401/403 → dead (invalid credentials).
// Token expiring within threshold → dead (pre-rotate).
// A 402 or 429 with "daily_limit" → dead (exhausted for the day).
export async function pickAccount(
	tokens: string[],
	startAt: number,
	send: (token: string) => Promise<Response>,
): Promise<PickResult> {
	const dead: Dead[] = [];
	const skipped: Skipped[] = [];
	let last!: { token: string; status: number; text: string; contentType: string | null };

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[(startAt + i) % tokens.length]!;

		// Pre-check expiry
		if (expiresSoon(token)) {
			dead.push({ token, reason: "expiring" });
			continue;
		}
		let res: Response;
		try {
			res = await send(token);
		} catch (e) {
			last = { token, status: 502, text: `upstream fetch failed: ${e instanceof Error ? e.message : String(e)}`, contentType: null };
			skipped.push({ token, status: 0 });
			continue;
		}

		const text = await res.text();
		last = { token, status: res.status, text, contentType: res.headers.get("content-type") };

		if (res.status === 401 || res.status === 403) {
			dead.push({ token, reason: "invalid_401" });
			continue;
		}

		if (res.status === 429) {
			// Check if daily limit or just per-minute
			if (text.includes("daily_limit") || text.includes("daily limit")) {
				dead.push({ token, reason: "exhausted" });
			} else {
				skipped.push({ token, status: 429 });
			}
			continue;
		}

		if (res.status === 402) {
			dead.push({ token, reason: "exhausted" });
			continue;
		}

		// 5xx = transient upstream
		if (res.status >= 500) {
			skipped.push({ token, status: res.status });
			continue;
		}

		return { token, res: rebuild(res.status, text, last.contentType), dead, skipped };
	}

	return {
		token: last.token,
		res: rebuild(last.status, last.text, last.contentType),
		dead,
		skipped,
	};
}
