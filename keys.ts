// Token parsing helpers. Pure, no deps.

// JWT (eyJ….….…) or a 32-hex apikey.
export function looksLikeToken(v: string): boolean {
	return /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(v) || /^[a-f0-9]{32}$/i.test(v);
}

// Pull the bearer JWT out of whatever you paste: a devtools JSON blob (with or
// without a "Response data:" prefix), a vscode://…/auth?…=<tok> URL, a bare
// query string, or a raw token.
export function extractKey(raw: string): string {
	const s = raw.trim();
	if (!s) return "";
	const braceAt = s.indexOf("{");
	if (braceAt !== -1 && s.lastIndexOf("}") > braceAt) {
		try {
			const j = JSON.parse(s.slice(braceAt, s.lastIndexOf("}") + 1));
			const tok = j.access_token?.access_token ?? j.access_token ?? j.apikey;
			if (typeof tok === "string") return tok.trim();
		} catch {}
	}
	if (s.includes("=") && (s.includes("://") || s.startsWith("?") || s.startsWith("auth?"))) {
		const q = new URLSearchParams(s.slice(s.indexOf("?") + 1));
		const named = q.get("access_token") || q.get("token") || q.get("apikey") || q.get("a");
		if (named) return named.trim();
		for (const v of q.values()) if (looksLikeToken(v)) return v.trim();
		return s;
	}
	return s;
}
