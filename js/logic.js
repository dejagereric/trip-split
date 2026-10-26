// Pure balance math. All amounts are integer cents.

export function cents(s) {
  const v = parseFloat(String(s ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(v) ? Math.round(v * 100) : 0;
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
