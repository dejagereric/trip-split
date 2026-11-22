// Pure balance math. All amounts are integer cents.

export function cents(s) {
  const v = parseFloat(String(s ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(v) ? Math.round(v * 100) : 0;
}

// How amounts are typed. USD (and every currency other than EUR): comma between thousands,
// period before the cents, "1,234.56". EUR: the other way round, "1.234,56".
export const decimalComma = (cur) => cur === 'EUR';
export const amountExample = (cur) => (decimalComma(cur) ? '1.234,50' : '1,234.50');

// A typed amount in `cur` → integer cents. Returns 0 for an empty amount, and NaN when the
// separators don't follow the currency's convention (e.g. "1,5" in USD or "1,234.50" in EUR), so the
// form can ask instead of guessing. Thousands separators must sit between groups of 3 digits.
// One exception: in EUR, a single period followed by just 1 or 2 digits ("12.50", "12.5") can't be
// a thousands separator, so it's read as the decimal point. Phone number pads set to English often
// have no comma key.
export function parseAmount(s, cur = 'USD') {
  const comma = decimalComma(cur);
  const dec = comma ? ',' : '.';
  const grp = comma ? '.' : ',';
  const t = String(s ?? '').replace(/[^0-9.,]/g, '');
  if (!/[0-9]/.test(t)) return 0;
  if (comma && /^[0-9]*\.[0-9]{1,2}$/.test(t)) return Math.round(parseFloat('0' + t) * 100);
  const parts = t.split(dec);
  if (parts.length > 2) return NaN;
  const [whole, frac = ''] = parts;
  if (frac.includes(grp)) return NaN;
  const groups = whole.split(grp);
  if (groups.length > 1 && (!groups[0] || groups.slice(1).some((g) => g.length !== 3))) return NaN;
  return Math.round(parseFloat((groups.join('') || '0') + '.' + (frac || '0')) * 100);
}

// Cents → the text the amount field shows when it's filled in for you ("12.50" or "12,50").
export function amountInput(c, cur = 'USD') {
  const s = (c / 100).toFixed(2);
  return decimalComma(cur) ? s.replace('.', ',') : s;
}

// Split `total` cents evenly across `ids`; leftover cents go to the first ids.
export function splitEqual(total, ids) {
  const out = {};
  const n = ids.length;
  if (!n) return out;
  const base = Math.floor(total / n);
  const rem = total - base * n;
  ids.forEach((id, i) => { out[id] = base + (i < rem ? 1 : 0); });
  return out;
}

// paid = what each party spent out of pocket; share = what they benefitted from;
// sent/recv = settle-up payments. net > 0 means the party is owed money.
export function computeBalances(entries, ids) {
  const b = {};
  ids.forEach((id) => { b[id] = { paid: 0, share: 0, sent: 0, recv: 0 }; });
  let total = 0;
  let expCount = 0;
  for (const e of entries) {
    if (e.kind === 'payment') {
      if (b[e.from]) b[e.from].sent += e.amount;
      if (b[e.to]) b[e.to].recv += e.amount;
    } else {
      total += e.amount;
      expCount++;
      if (b[e.payer]) b[e.payer].paid += e.amount;
      for (const [id, c] of Object.entries(e.shares || {})) if (b[id]) b[id].share += c;
    }
  }
  const net = {};
  ids.forEach((id) => { net[id] = b[id].paid - b[id].share + b[id].sent - b[id].recv; });
  return { b, net, total, expCount };
}

// Fewest payments that clear every balance (greedy; for three parties, at most two).
export function minimalTransfers(net, ids) {
  const cred = ids.filter((id) => net[id] > 0).map((id) => ({ id, a: net[id] })).sort((x, y) => y.a - x.a);
  const debt = ids.filter((id) => net[id] < 0).map((id) => ({ id, a: -net[id] })).sort((x, y) => y.a - x.a);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < debt.length && j < cred.length) {
    const m = Math.min(debt[i].a, cred[j].a);
    if (m > 0) out.push({ from: debt[i].id, to: cred[j].id, amount: m });
    debt[i].a -= m;
    cred[j].a -= m;
    if (debt[i].a === 0) i++;
    if (cred[j].a === 0) j++;
  }
  return out;
}

// ---------- currency conversion ----------
// rate: 1 unit of the spent currency = `rate` units of the trip's ledger currency.
export const convert = (amount, rate) => Math.round(amount * rate);

// Convert per-person shares (in the spent currency) to the ledger currency so they
// add up exactly to the converted total; any rounding cent goes to the largest share.
export function convertShares(origShares, rate, convTotal) {
  const ids = Object.keys(origShares);
  const out = {};
  ids.forEach((id) => { out[id] = convert(origShares[id], rate); });
  const diff = convTotal - ids.reduce((a, id) => a + out[id], 0);
  if (diff && ids.length) {
    const big = ids.reduce((a, b) => (origShares[b] > origShares[a] ? b : a));
    out[big] += diff;
  }
  return out;
}

// ---------- proportional split ----------
// Split `total` cents across `ids` in proportion to `weights` ({id: number}); shares add up
// exactly to `total` (largest remainders get the leftover cents). Ids with weight 0 get 0.
export function splitWeighted(total, weights, ids) {
  const w = ids.map((id) => Math.max(0, Number(weights[id]) || 0));
  const sum = w.reduce((a, b) => a + b, 0);
  const out = {};
  if (!sum) { ids.forEach((id) => { out[id] = 0; }); return out; }
  const exact = w.map((x) => (total * x) / sum);
  const base = exact.map(Math.floor);
  let left = total - base.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => [x - base[i], i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; left > 0 && k < order.length; k++, left--) base[order[k][1]] += 1;
  ids.forEach((id, i) => { out[id] = base[i]; });
  return out;
}
