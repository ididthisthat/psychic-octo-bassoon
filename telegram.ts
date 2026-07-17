// Optional Telegram control. Off unless TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID set.
// Long-polls for commands (owner chat only) and pushes a throttled alert when
// all accounts are spent.

export type TgHandlers = {
	status: () => Promise<string>;
	dead: () => Promise<string>;
	probe: () => Promise<string>;
	addToken: (raw: string) => Promise<{ added: boolean; id: string }>;
	mint: () => Promise<{ added: boolean; id: string }>;
	setPause: (kind: string) => Promise<void>;
	clearPause: (kind: string) => Promise<void>;
};
export type Notifier = { notify: (msg: string, opts?: { throttle?: boolean }) => void };

const HELP = `cmds:
status — active accounts + last-ok timestamps
list   — same as status
dead   — dead account archive with reasons
probe  — live-test each active account (costs 1 req each)
add <token> — add a raw JWT or devtools blob
mint   — auto-mint a new account via mail.tm
pause  — stop auto-minting
resume — resume auto-minting
help   — this message

Auto-mint runs every 80-90 min. Status report every ~6h.`;

export function startTelegram(h: TgHandlers): Notifier | null {
	const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
	const CHAT = process.env.TELEGRAM_CHAT_ID ?? "";
	if (!TOKEN || !CHAT) return null;

	const api = (method: string, body: unknown) =>
		fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	const send = (text: string) => api("sendMessage", { chat_id: CHAT, text: text.length > 4000 ? text.slice(0, 3997) + "..." : text });

	const handle = async (text: string): Promise<void> => {
		const [cmd, ...rest] = text.replace(/^\//, "").trim().split(/\s+/);
		const reply = (msg: string) => send(msg).catch(() => {});
		try {
			if (cmd === "status" || cmd === "list") {
				await reply(await h.status()); return;
			}
			if (cmd === "dead") {
				const d = await h.dead();
				await reply(d || "✅ No dead accounts."); return;
			}
			if (cmd === "probe") {
				await reply("🔍 Probing...");
				await reply(await h.probe()); return;
			}
			if (cmd === "help") { await reply(HELP); return; }
			if (cmd === "add") {
				const r = await h.addToken(rest.join(" "));
				await reply(r.added ? `✅ Added \`${r.id}\`` : `⚠️ Already have \`${r.id}\``); return;
			}
			if (cmd === "mint") {
				await reply("⏳ Minting via mail.tm...");
				const r = await h.mint();
				await reply(r.added ? `✅ Minted \`${r.id}\`` : `⚠️ Already have \`${r.id}\``); return;
			}
			if (cmd === "pause") {
				await h.setPause("oxlo");
				await reply("⏸ Minting paused."); return;
			}
			if (cmd === "resume") {
				await h.clearPause("oxlo");
				await reply("▶ Minting resumed."); return;
			}
			await reply(HELP);
		} catch (e) {
			await reply(`❌ ${e instanceof Error ? e.message : String(e)}`);
		}
	};

	const poll = async (): Promise<void> => {
		let offset = 0;
		for (;;) {
			try {
				const r = await api("getUpdates", { offset, timeout: 30 });
				const { result } = await r.json();
				for (const u of result ?? []) {
					offset = u.update_id + 1;
					const msg = u.message;
					if (msg?.text && String(msg.chat?.id) === CHAT) await handle(String(msg.text));
				}
			} catch {
				await Bun.sleep(3000);
			}
		}
	};
	void poll();

	let last = 0;
	return {
		notify: (msg: string, opts?: { throttle?: boolean }) => {
			if (opts?.throttle !== false) {
				const now = Date.now();
				if (now - last < 60_000) return;
				last = now;
			}
			void send(msg).catch(() => {});
		},
	};
}
