// Supabase Edge Function: exchange rate for a given day.
// Deploy:  supabase functions deploy fx-rate --no-verify-jwt
// Rates come from Frankfurter (https://frankfurter.dev): free, no key, mid-market, daily.
// Request: POST {"from":"EUR","to":"USD","date":"2026-10-17"}  or  GET ?from=EUR&to=USD&date=2026-10-17
//   ->  {"rate":1.1229,"date":"2026-10-17"}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-group-id',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json', ...extra } });

// Rates for past days never change, so keep them for the life of this function instance.
const cache = new Map<string, { rate: number; date: string }>();

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  let body: { from?: string; to?: string; date?: string };
  if (req.method === 'GET') {
    const q = new URL(req.url).searchParams;
    body = { from: q.get('from') ?? '', to: q.get('to') ?? '', date: q.get('date') ?? undefined };
  } else if (req.method === 'POST') {
    try { body = await req.json(); } catch { return json({ error: 'bad_request' }, 400); }
  } else return json({ error: 'method_not_allowed' }, 405);
  const from = String(body.from ?? '').toUpperCase();
  const to = String(body.to ?? '').toUpperCase();
  const today = new Date().toISOString().slice(0, 10);
  let date = String(body.date ?? today);
  if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) return json({ error: 'bad_currency' }, 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: 'bad_date' }, 400);
  if (date > today) date = today; // no rates for future days yet
  if (from === to) return json({ rate: 1, date });

  const key = `${date}:${from}:${to}`;
  const hit = cache.get(key);
  if (hit && date < today) return json(hit);

  const res = await fetch(`https://api.frankfurter.dev/v2/rate/${from.toLowerCase()}/${to.toLowerCase()}?date=${date}`);
  if (!res.ok) return json({ error: 'rate_unavailable', status: res.status }, 502);
  const data = await res.json();
  const rate = Number(data?.rate);
  if (!Number.isFinite(rate) || rate <= 0) return json({ error: 'rate_unavailable' }, 502);
  const out = { rate, date: typeof data.date === 'string' ? data.date : date };
  cache.set(key, out);
  return json(out, 200, { 'Cache-Control': date < today ? 'public, max-age=86400' : 'public, max-age=3600' });
});
