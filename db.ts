// Postgres-backed account pool. Same schema as sixth-proxy.
// Oxlo JWT tokens, 7-day expiry, rotated on 429/expiry.

import { SQL } from "bun";
import { accountIdFrom } from "./auth.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required (Postgres connection string).");

const sql = new SQL(url);

export type AccountRow = {
	id: string;
	last_error: string | null;
	last_ok_at: Date | null;
	checked_at: Date | null;
	created_at: Date;
};
export type DeadRow = { id: string; reason: string; died_at: Date };
export type DeadReason = "invalid_401" | "expiring" | "exhausted";

export async function initDb(): Promise<void> {
	await sql`
		CREATE TABLE IF NOT EXISTS accounts (
			id          TEXT PRIMARY KEY,
			token       TEXT NOT NULL,
			last_error  TEXT,
			last_ok_at  TIMESTAMPTZ,
			checked_at  TIMESTAMPTZ,
			created_at  TIMESTAMPTZ DEFAULT now()
		)`;
	await sql`
		CREATE TABLE IF NOT EXISTS dead_accounts (
			id       TEXT PRIMARY KEY,
			token    TEXT NOT NULL,
			reason   TEXT NOT NULL,
			died_at  TIMESTAMPTZ DEFAULT now()
		)`;
	await sql`
		CREATE TABLE IF NOT EXISTS mint_log (
			kind       TEXT PRIMARY KEY,
			minted_at  TIMESTAMPTZ NOT NULL DEFAULT now()
		)`;
}

export async function loadActive(): Promise<string[]> {
	const rows = await sql`SELECT token FROM accounts ORDER BY created_at`;
	return rows.map((r: { token: string }) => r.token);
}

export async function upsertAccount(token: string): Promise<{ added: boolean; id: string }> {
	const id = accountIdFrom(token);
	await sql`DELETE FROM dead_accounts WHERE id = ${id}`;
	const inserted = await sql`
		INSERT INTO accounts (id, token) VALUES (${id}, ${token})
		ON CONFLICT (id) DO NOTHING
		RETURNING id`;
	return { added: inserted.length > 0, id };
}

export async function markOk(id: string): Promise<void> {
	await sql`UPDATE accounts SET last_ok_at = now(), checked_at = now(), last_error = NULL WHERE id = ${id}`;
}

export async function markError(id: string, code: string): Promise<void> {
	await sql`UPDATE accounts SET last_error = ${code}, checked_at = now() WHERE id = ${id}`;
}

export async function moveDead(id: string, token: string, reason: DeadReason): Promise<void> {
	await sql.begin(async (tx) => {
		await tx`DELETE FROM accounts WHERE id = ${id}`;
		await tx`
			INSERT INTO dead_accounts (id, token, reason) VALUES (${id}, ${token}, ${reason})
			ON CONFLICT (id) DO UPDATE SET reason = ${reason}, died_at = now()`;
	});
}

export async function listActive(): Promise<AccountRow[]> {
	return (await sql`
		SELECT id, last_error, last_ok_at, checked_at, created_at
		FROM accounts ORDER BY created_at`) as AccountRow[];
}

export async function listDead(): Promise<DeadRow[]> {
	return (await sql`SELECT id, reason, died_at FROM dead_accounts ORDER BY died_at DESC`) as DeadRow[];
}

export async function getLastMint(kind: string): Promise<Date | null> {
	const rows = await sql`SELECT minted_at FROM mint_log WHERE kind = ${kind}` as { minted_at: Date }[];
	if (rows.length === 0) return null;
	return rows[0].minted_at;
}

export async function recordMint(kind: string): Promise<void> {
	await sql`
		INSERT INTO mint_log (kind, minted_at) VALUES (${kind}, now())
		ON CONFLICT (kind) DO UPDATE SET minted_at = now()`;
}
