/**
 * DocStruct — AI-powered document → structured data extraction API
 * Cloudflare Worker. Free tier with rate limiting.
 *
 * Endpoints:
 *   POST /v1/extract   body: {"text":"...","type":"invoice|receipt|statement|auto","output":"json|csv"}
 *   GET  /v1/health
 *   GET  /v1/models
 *
 * AI backend: one of my web bridges (Gemini/Kimi) via env var, near-zero cost.
 */
const ALLOWED = new Set(['invoice', 'receipt', 'statement', 'bank_statement', 'contract', 'auto']);
const ACCEPTED = ['invoice', 'receipt', 'statement', 'auto'];

const SYSTEM_PROMPT = `You are a precise structured-data extraction engine. You convert messy document text into clean structured JSON. Rules:
1. Return ONLY valid JSON. No markdown fences, no commentary, no code blocks.
2. Use the exact schema for the requested document type.
3. If a field is not present, use null (or empty array). Never make up values.
4. Normalize dates to YYYY-MM-DD. Keep amounts as numbers (or strings for line items).
5. Monetary amounts: include number only; report currency separately.

SCHEMAS:
- invoice/receipt: {"type":"invoice","vendor":{"name":"","address":"","phone":"","email":""},"customer":{"name":"","address":""},"number":"","date":null,"due_date":null,"currency":"","line_items":[{"description":"","quantity":null,"unit_price":null,"line_total":null}],"subtotal":null,"tax":null,"discount":null,"total":null,"payment_status":"","notes":""}
- statement/bank_statement: {"type":"statement","account_holder":"","account_number":"","bank":"","period_start":null,"period_end":null,"currency":"","opening_balance":null,"closing_balance":null,"transactions":[{"date":null,"description":"","amount":null,"balance":null}],"summary":{"deposits":null,"withdrawals":null}}
- contract: {"type":"contract","parties":[{"name":""}],"effective_date":null,"expiration_date":null,"renewal_terms":"","payment_terms":"","key_clauses":[{"title":"","text":""}],"signature_requirements":"","jurisdiction":""}`;

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
    'Access-Control-Max-Age': '86400',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors() },
  });
}

function err(message, status = 400) {
  return json({ error: message }, status);
}

async function callLLM(text, type, env, request) {
  // Use service binding to kimi bridge (avoids cross-subdomain HTTP routing bug)
  const bridge = env.KIMI_BRIDGE || env.GEMINI_BRIDGE;
  const model = env.AI_MODEL || 'kimi-k2';
  const userMsg = `Document type requested: ${type}\n\nDocument text:\n${text.slice(0, 60000)}`;
  const payload = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMsg },
    ],
    temperature: 0,
  };
  const target = new URL('https://internal/v1/chat/completions');
  const body = JSON.stringify(payload);
  const resp = await bridge.fetch(new Request(target, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.AI_API_KEY}`,
      'User-Agent': 'curl/8.0',
    },
    body,
  }));
  if (!resp.ok) {
    const text = (await resp.text()).slice(0, 500);
    throw new Error(`LLM upstream ${resp.status}: ${text}`);
  }
  const data = await resp.json();
  let content = data?.choices?.[0]?.message?.content || '';
  // strip markdown fences if present
  content = content.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(content);
  } catch (e) {
    // try to find first { ... last }
    const s = content.indexOf('{');
    const e2 = content.lastIndexOf('}');
    if (s >= 0 && e2 > s) {
      try { return JSON.parse(content.slice(s, e2 + 1)); } catch (e2b) {}
    }
    throw new Error('LLM returned non-JSON');
  }
}

async function getUsage(key, env) {
  if (!key || !env.USAGE) return null;
  const v = await env.USAGE.get(key);
  return v ? JSON.parse(v) : { count: 0 };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors() });
    }

    // Health
    if (method === 'GET' && url.pathname === '/v1/health') {
      return json({ status: 'ok', service: 'docstruct', time: Date.now() });
    }

    // Models
    if (method === 'GET' && url.pathname === '/v1/models') {
      return json({ models: [env.AI_MODEL || 'kimi-k2'], default: env.AI_MODEL || 'kimi-k2' });
    }

    // Waitlist / early access signup
    if (method === 'POST' && url.pathname === '/v1/waitlist') {
      let body;
      try { body = await request.json(); } catch { return err('Invalid JSON body', 400); }
      const email = (body.email || '').toString().trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err('Invalid email', 400);
      const at = new Date().toISOString();
      const key = 'wl:' + email;
      const existing = await env.WAITLIST.get(key);
      if (!existing) {
        await env.WAITLIST.put(key, JSON.stringify({ email, at, source: 'landing' }));
      }
      return json({ ok: true, message: 'You are on the early-access list. We will email you when paid plans open.' });
    }

    // Pageview counter (lightweight self-hosted analytics)
    if (method === 'POST' && url.pathname === '/v1/track') {
      const ip = request.headers.get('CF-Connecting-IP') || 'anon';
      const today = new Date().toISOString().slice(0, 10);
      const pk = 'pv:' + today;
      const cur = await env.WAITLIST.get(pk);
      await env.WAITLIST.put(pk, JSON.stringify({ pv: (cur ? JSON.parse(cur).pv : 0) + 1 }));
      return json({ ok: true });
    }

    // Extract
    if (method === 'POST' && url.pathname === '/v1/extract') {
      const apiKeyHeader = request.headers.get('X-API-Key') || request.headers.get('Authorization');
      let apiKey = apiKeyHeader || '';
      let keyPlan = null;
      if (apiKey) {
        // strip possible 'Bearer ' prefix
        apiKey = apiKey.replace(/^Bearer\s+/i, '').trim();
        // Validate against DevPortal KEYS namespace
        if (env.KEYS) {
          const kv = await env.KEYS.get(apiKey, 'json');
          if (kv) {
            keyPlan = kv; // { plan, month_start, monthly, used, created }
          } else {
            return err('Invalid API key', 401);
          }
        }
      }
      let body;
      try { body = await request.json(); } catch { return err('Invalid JSON body', 400); }

      const text = (body.text || '').toString();
      if (text.trim().length < 40) {
        return err('text must be at least 40 characters', 400);
      }
      let type = (body.type || 'auto').toString().toLowerCase();
      if (!ALLOWED.has(type)) return err('type must be one of: ' + [...ALLOWED].join(', '), 400);
      const output = (body.output || 'json').toString().toLowerCase();
      if (!['json', 'csv'].includes(output)) return err('output must be json or csv', 400);

      // Enforce quota for paid key
      if (keyPlan) {
        if (keyPlan.used >= keyPlan.monthly) {
          return err('Monthly quota exceeded (' + keyPlan.used + '/' + keyPlan.monthly + ').', 429);
        }
        keyPlan.used += 1;
        // reset month if a new month started
        const now = Date.now();
        if (now - keyPlan.month_start > 30 * 86400 * 1000) {
          keyPlan.month_start = now; keyPlan.used = 1;
        }
        await env.KEYS.put(apiKey, JSON.stringify(keyPlan));
      } else {
        // Free-tier rate limit via IP (only when no API key)
        const ip = request.headers.get('CF-Connecting-IP') || 'anon';
        const hit = await getUsage('ip:' + ip, env);
        const count = (hit?.count || 0);
        if (count >= (env.FREE_DAILY_LIMIT ? Number(env.FREE_DAILY_LIMIT) : 20)) {
          return err('Free tier limit reached for today (' + count + '/20). Add an API key for higher limits.', 429);
        }
        await env.USAGE.put('ip:' + ip, JSON.stringify({ count: count + 1 }), { expirationTtl: 86400 });
      }

      try {
        const result = await callLLM(text, type === 'auto' ? 'auto' : type, env, request);
        if (output === 'csv') {
          const csv = toCSV(result, type);
          return new Response(csv, {
            status: 200,
            headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="docstruct.csv"', ...cors() },
          });
        }
        return json({ ok: true, usage: keyPlan ? { plan: keyPlan.plan, used: keyPlan.used, monthly: keyPlan.monthly } : 'free', data: result });
      } catch (ex) {
        return err('Extraction failed: ' + ex.message, 502);
      }
    }

    return err('Not found', 404);
  },
};

function toCSV(result, type) {
  // simple flatten of top-level scalar fields + line items
  const rows = [];
  const flatten = (obj, prefix = '') => {
    const out = {};
    for (const [k, v] of Object.entries(obj || {})) {
      const key = prefix ? prefix + '.' + k : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        Object.assign(out, flatten(v, key));
      } else if (Array.isArray(v) && v.length && typeof v[0] === 'object') {
        v.forEach((item, i) => Object.assign(out, flatten(item, `${key}[${i}]`)));
      } else {
        out[key] = v;
      }
    }
    return out;
  };
  const flat = flatten(result);
  const headers = Object.keys(flat);
  const esc = (s) => (s == null ? '' : String(s).replace(/"/g, '""'));
  return headers.join(',') + '\n' + headers.map((h) => '"' + esc(flat[h]) + '"').join(',') + '\n';
}
