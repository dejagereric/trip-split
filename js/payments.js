// Payment app handles: how a person likes to be paid back. Links only open that person's page
// in the payment app (with the amount filled in where the app supports it). Trip Split never moves money.

// Accepts "@name", "$name", "name", or a pasted profile address like "paypal.me/name" or
// "https://venmo.com/u/name", and keeps just the name.
const clean = (h) => String(h || '').trim()
  .replace(/^(https?:\/\/)?(www\.|account\.)?(paypal\.me|paypal\.com\/paypalme|venmo\.com(\/u)?|cash\.app|revolut\.me)\/+/i, '')
  .replace(/[/?#].*$/, '')
  .replace(/^[@$]+/, '');
const amt = (cents) => (Math.max(0, cents) / 100).toFixed(2);

export const PAY_METHODS = [
  { key: 'venmo', label: 'Venmo', placeholder: '@username', usdOnly: true,
    url: (h, cents, cur, note) => `https://venmo.com/?txn=pay&recipients=${encodeURIComponent(clean(h))}` + (cents && cur === 'USD' ? `&amount=${amt(cents)}` : '') + (note ? `&note=${encodeURIComponent(note)}` : '') },
  { key: 'paypal', label: 'PayPal', placeholder: 'paypal.me name',
    url: (h, cents, cur) => `https://paypal.me/${encodeURIComponent(clean(h))}` + (cents ? `/${amt(cents)}${cur || ''}` : '') },
  { key: 'cashapp', label: 'Cash App', placeholder: '$cashtag', usdOnly: true,
    url: (h, cents, cur) => `https://cash.app/$${encodeURIComponent(clean(h))}` + (cents && cur === 'USD' ? `/${amt(cents)}` : '') },
  { key: 'revolut', label: 'Revolut', placeholder: 'revolut.me name',
    url: (h) => `https://revolut.me/${encodeURIComponent(clean(h))}` },
  { key: 'zelle', label: 'Zelle', placeholder: 'email or phone used for Zelle',
    url: null }, // Zelle has no public pay links; share the address instead
  { key: 'other', label: 'Other link', placeholder: 'https://…',
    url: (h) => (/^https:\/\/\S+$/i.test(String(h || '').trim()) ? String(h).trim() : null) },
];

// The person's methods, preferred first: [{ key, label, handle, url }]
export function payOptions(person, cents = 0, cur = '', note = '') {
  const p = person?.payment || {};
  const list = PAY_METHODS.filter((m) => String(p[m.key] || '').trim())
    .map((m) => ({ key: m.key, label: m.label, handle: String(p[m.key]).trim(), url: m.url ? m.url(p[m.key], cents, cur, note) : null }));
  const pref = p.preferred;
  list.sort((a, b) => (a.key === pref ? -1 : b.key === pref ? 1 : 0));
  return list;
}

// One line per method, for messages: "Venmo: https://…" / "Zelle: name@example.com"
export function payLines(person, cents, cur, note) {
  return payOptions(person, cents, cur, note).map((o) => `${o.label}: ${o.url || o.handle}`);
}

// Tidy what someone typed before saving.
export function cleanPayment(form) {
  const out = {};
  PAY_METHODS.forEach((m) => {
    let v = String(form[m.key] || '').trim();
    if (!v) return;
    if (m.key === 'venmo' || m.key === 'cashapp' || m.key === 'revolut' || m.key === 'paypal') v = clean(v).replace(/[^\w.\-]/g, '');
    if (m.key === 'other' && !/^https:\/\//i.test(v)) v = 'https://' + v.replace(/^\/+/, '');
    if (v) out[m.key] = v.slice(0, 120);
  });
  if (form.preferred && out[form.preferred]) out.preferred = form.preferred;
  return out;
}
