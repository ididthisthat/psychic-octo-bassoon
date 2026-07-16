// Proactive account minting on a timer (every 50-60 min), independent of
// request load. Survives redeploys via mint_log table — computes catch-up
// delay from last recorded mint so a restart doesn't reset the clock.
//
// Also: periodic Telegram status push every ~6h with jitter.

import { getLastMint, recordMint } from "./db.ts";
import type { Notifier } from "./telegram.ts";

const MINT_INTERVAL_MS = 50 * 60 * 1000;       // 50 min base
const MINT_JITTER_MS  = 10 * 60 * 1000;        // + 0-10 min random
const REPORT_INTERVAL_MS = 6 * 60 * 60 * 1000;  // 6h base
const REPORT_JITTER_MS  = 30 * 60 * 1000;       // + 0-30 min random

function jitter(max: number): number {
	return Math.floor(Math.random() * max);
}

function scheduleFire(
	baseInterval: number,
	jitterMax: number,
	fn: () => Promise<void>,
): void {
	const interval = baseInterval + jitter(jitterMax);
	setTimeout(async () => {
		await fn();
		scheduleFire(baseInterval, jitterMax, fn);
	}, interval);
}

async function scheduleLoop(
	kind: string,
	baseInterval: number,
	jitterMax: number,
	fn: () => Promise<void>,
): Promise<void> {
	const last = await getLastMint(kind);
	if (!last) {
		// No mint recorded yet — do one now, then start recurring.
		await fn();
		scheduleFire(baseInterval, jitterMax, fn);
		return;
	}
	const elapsed = Date.now() - last.getTime();
	const interval = baseInterval + jitter(jitterMax);
	const delay = Math.max(0, interval - elapsed);
	setTimeout(() => scheduleFire(baseInterval, jitterMax, fn), delay);
}

// ── public ──

export function startMintScheduler(
	notifier: Notifier | null,
	mint: () => Promise<void>,
): void {
	const mintAndLog = async () => {
		try {
			await mint();
			await recordMint("oxlo");
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			console.error("scheduled mint failed:", msg);
			notifier?.notify(`\u274C Scheduled mint failed: ${msg.slice(0, 200)}`);
		}
	};
	scheduleLoop("oxlo", MINT_INTERVAL_MS, MINT_JITTER_MS, mintAndLog);
	console.log("mint-scheduler: every 50-60 min");
}

export function startPeriodicReport(
	notifier: Notifier | null,
	getStatus: () => Promise<string>,
): void {
	if (!notifier) return;
	const tick = () => {
		const interval = REPORT_INTERVAL_MS + jitter(REPORT_JITTER_MS);
		setTimeout(async () => {
			try {
				const status = await getStatus();
				notifier.notify(`\u{1F4CA} Periodic report:\n${status}`);
			} catch (e) {
				console.error("periodic-report failed:", e instanceof Error ? e.message : e);
			}
			tick();
		}, interval);
	};
	tick();
}
