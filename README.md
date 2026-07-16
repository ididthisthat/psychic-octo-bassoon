# Oxlo Proxy — OpenAI-compatible proxy for Oxlo.ai free-tier models

Zero-cost AI proxy with automatic account rotation. Uses Oxlo.ai's free tier
(6 models including DeepSeek V3.2 at 671B params) and auto-mints accounts
via mail.tm disposable email.

## Why

Oxlo.ai free tier: 5 req/min, 60 req/day per account. This proxy pools
multiple accounts, auto-mints fresh ones when the pool shrinks, and rotates on
rate limits so the client never sees a 429.

## Quick start (local, Docker)

```
cp .env.example .env      # set PROXY_API_KEY, ADMIN_TOKEN, DATABASE_URL
docker compose up -d      # proxy + postgres
```

Or run bare:
```
DATABASE_URL=postgres://... PROXY_API_KEY=... ADMIN_TOKEN=... bun start
```

## Environment

| Var | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string |
| `PROXY_API_KEY` | yes | Client gate for `/v1/*` |
| `ADMIN_TOKEN` | yes | Gate for `/admin/*` |
| `OXLO_TOKENS` | no | Seed tokens on first boot (comma/newline) |
| `TELEGRAM_BOT_TOKEN` | no | Telegram bot (from @BotFather) |
| `TELEGRAM_CHAT_ID` | no | Telegram owner chat (from @userinfobot) |
| `OXLO_PORT` | no | Listen port (default 8761) |
| `OXLO_HOST` | no | Listen host (default 127.0.0.1) |

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/v1/chat/completions` | `Bearer PROXY_API_KEY` | Proxied + rotated chat |
| POST | `/v1/images/generations` | `Bearer PROXY_API_KEY` | Image gen (SD 1.5) |
| GET | `/v1/models` | open | 6 free models |
| GET | `/health` | open | `{ ok, tokens, cursor }` |
| GET | `/admin/accounts` | `x-admin-token` | Active accounts |
| GET | `/admin/dead` | `x-admin-token` | Dead account archive |
| POST | `/admin/probe` | `x-admin-token` | Live-probe each account |
| POST | `/admin/add` | `x-admin-token` | `{ token }` — add raw JWT or devtools blob |
| POST | `/admin/mint` | `x-admin-token` | Auto-mint via mail.tm |

## Models

| Model | Type | Notes |
|---|---|---|
| `deepseek-v3.2` | Chat (671B) | Best free code gen model |
| `deepseek-r1-8b` | Chat (reasoning) | Reasoning, verbose |
| `gemma-3-4b` | Chat | Google, fast |
| `llama-3.2-3b` | Chat | Meta, lightweight |
| `mistral-7b` | Chat | Solid 7B all-rounder |
| `stable-diffusion-1.5` | Image | 512x512 image gen |

## Rotation

`pickAccount` tries tokens in order. 200 → wins. 429 (per-minute) → skip to
next. 429 with `daily_limit` text / 402 → dead (exhausted). 401/403 → dead
(invalid). JWT expiring within 24h → pre-emptively dead. 5xx → skip
(transient). All dead → last error surfaces.

## Auto-mint

When active accounts drop below 3, the proxy auto-mints a fresh account via
mail.tm (signup → email verification → JWT). Throttled to one mint per 3-5
minutes to avoid hammering the Oxlo signup endpoint.

## Telegram (optional)

Set `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` for remote control:

```
status  — active accounts + last-ok timestamps
dead    — dead account archive
probe   — live-test each account
add     — add raw JWT or devtools blob
mint    — auto-mint new account
```

Push alerts when all accounts are dead or a new account is auto-minted
(throttled to 1/min).

## Architecture

Postgres pool, `pickAccount` rotation, fire-and-forget bookkeeping.
`auth.ts` handles mail.tm inbox creation + Oxlo signup + email verification
polling — fully automated, no human inbox needed. `keys.ts` parses devtools
blobs, vscode URLs, and raw JWTs. Same pattern as sixth-proxy.
