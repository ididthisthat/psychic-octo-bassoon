// Oxlo account minting via mail.tm + signup/verify flow.
// Returns a 7-day JWT access token. Full automation — no human inbox needed.

const MAILTM = "https://api.mail.tm";
const OXLO = "https://api.oxlo.ai";
const MAILTM_PASSWORD = "oxloproxypass"; // shared across all inboxes

interface MailTmAccount {
	email: string;
	token: string;
}

// Create a disposable mail.tm inbox
export async function createInbox(): Promise<MailTmAccount> {
	// Get available domain
	const domRes = await fetch(`${MAILTM}/domains`);
	const domains = await domRes.json();
	const domainList: string[] = (domains?.["hydra:member"] || domains?.member || [])
		.map((d: { domain: string }) => d.domain);
	if (!domainList.length) throw new Error("mail.tm: no domains available");
	const domain = domainList[0];

	const email = `oxlo-${Date.now()}@${domain}`;

	// Create account
	const accRes = await fetch(`${MAILTM}/accounts`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ address: email, password: MAILTM_PASSWORD }),
	});
	if (!accRes.ok) {
		const err = await accRes.text();
		throw new Error(`mail.tm account creation failed (${accRes.status}): ${err}`);
	}

	// Login to get token
	const loginRes = await fetch(`${MAILTM}/token`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ address: email, password: MAILTM_PASSWORD }),
	});
	const loginData = await loginRes.json();
	if (!loginData.token) throw new Error("mail.tm: login failed");

	return { email, token: loginData.token };
}

// Poll inbox for Oxlo verification code
export async function pollForCode(mailToken: string, timeoutMs = 30000): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const res = await fetch(`${MAILTM}/messages`, {
			headers: { Authorization: `Bearer ${mailToken}` },
		});
		const inbox = await res.json();
		const messages: { id: string }[] = inbox?.["hydra:member"] || [];

		if (messages.length > 0) {
			const msgRes = await fetch(`${MAILTM}/messages/${messages[0].id}`, {
				headers: { Authorization: `Bearer ${mailToken}` },
			});
			const msg = await msgRes.json();
			const text = msg?.text || msg?.html || "";
			const match = text.match(/\b(\d{6})\b/);
			if (match) return match[1];
		}
		await new Promise((r) => setTimeout(r, 3000));
	}
	throw new Error("Verification code not received within timeout");
}

// Full flow: create inbox → signup → poll → verify → return JWT
export async function mintToken(email?: string, password?: string): Promise<string> {
	const inbox = await createInbox();
	const userEmail = email || inbox.email;
	const userPassword = password || "OxloProxy123!";

	// Signup
	const signupRes = await fetch(`${OXLO}/auth/signup`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email: userEmail, password: userPassword }),
	});
	if (!signupRes.ok) {
		const err = await signupRes.text();
		throw new Error(`Oxlo signup failed (${signupRes.status}): ${err}`);
	}

	// Poll for code
	const code = await pollForCode(inbox.token);

	// Verify
	const verifyRes = await fetch(`${OXLO}/auth/verify-email`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ email: userEmail, code }),
	});
	const verifyData = await verifyRes.json();
	if (!verifyRes.ok) throw new Error(`Oxlo verify failed: ${JSON.stringify(verifyData)}`);
	if (!verifyData.access_token) throw new Error("Oxlo verify: no access_token in response");

	return verifyData.access_token;
}

// Extract JWT expiry for monitoring
export function tokenExpiry(token: string): Date | null {
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
		return payload.exp ? new Date(payload.exp * 1000) : null;
	} catch {
		return null;
	}
}

// Extract user ID from JWT for dedup
export function accountIdFrom(token: string): string {
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
		return payload.sub || "";
	} catch {
		return "";
	}
}
