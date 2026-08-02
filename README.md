# DocStruct API

**AI-powered: turn messy documents (invoices, receipts, bank statements) into clean structured JSON/CSV.**

## 🔴 Try it right now — no account, no signup
**Free web tool:** paste any invoice/statement/receipt → get clean CSV instantly at **[docstruct.pages.dev](https://docstruct.pages.dev)** (scroll to the live demo).
Drop-in API → **[Live API playground](https://docstruct.pages.dev/#demo)**

DocStruct is a developer-friendly API that converts raw document text into structured, machine-readable data in seconds. It's built and run on Cloudflare Workers with a near-zero marginal cost (AI inference via partner bridges) — so it's cheap, fast, and scales globally.

## Why DocStruct?
- **Structured output, every time** — clean JSON schema per document type (invoice, receipt, statement, contract).
- **No more manual data entry** — bookkeepers, e-commerce sellers, and accountants spend hours typing data from PDFs. DocStruct does it in seconds.
- **Simple API** — one POST request. No SDK required.
- **Developer-first** — CORS-enabled, free tier, JSON or CSV output.

## Quick start

```bash
curl -X POST https://docstruct.marwannaili-23-07.workers.dev/v1/extract \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Harbor Trading INVOICE INV-2026-1901 Date: 08/02/2026 Due: 08/16/2026 Bill To: Northwind LLC\n1 Widget Assembly $250.00\n2 Shipping $45.00\nTOTAL $295.00 USD",
    "type": "invoice",
    "output": "json"
  }'
```

Response:
```json
{
  "ok": true,
  "data": {
    "type": "invoice",
    "vendor": {"name": "Harbor Trading"},
    "number": "INV-2026-1901",
    "date": "2026-08-02",
    "due_date": "2026-08-16",
    "currency": "USD",
    "line_items": [
      {"description": "Widget Assembly", "quantity": 1, "unit_price": 250, "line_total": 250},
      {"description": "Shipping", "quantity": 1, "unit_price": 45, "line_total": 45}
    ],
    "total": 295
  }
}
```

## API reference

### `POST /v1/extract`
| Body field | Type | Default | Description |
|---|---|---|---|
| `text` | string | — | The raw document text to extract from (min 40 chars) |
| `type` | string | `auto` | `invoice`, `receipt`, `statement` / `bank_statement`, `contract`, or `auto` |
| `output` | string | `json` | `json` or `csv` |

### `GET /v1/health` — service status
### `GET /v1/models` — available extraction models

## Free tier
20 requests/day per IP, no API key required. Need more? Add a payment plan (coming soon).

## Architecture
- **Runtime:** Cloudflare Worker (edge, global)
- **AI backend:** via service bindings to partner AI bridges (Gemini / Kimi / Moonshot)
- **Rate limiting:** Cloudflare KV (per-IP, daily window)
- **CORS:** enabled for browser use

## Development
```bash
# install
npm i -g wrangler

# local dev
wrangler dev

# deploy
wrangler deploy
```

Secrets: `AI_API_KEY` (auth for the AI bridge). KV namespace `USAGE` for rate limiting.

## License
MIT
