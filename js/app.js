import { CONFIG } from './config.js';
import { cents, splitEqual, computeBalances, minimalTransfers } from './logic.js';
import { createStore } from './store.js';

// ---------- constants ----------
const COLORS = [
  { bg: '#3346C8', fg: '#FFFFFF' },
  { bg: '#F2A33A', fg: '#1B1A17' },
  { bg: '#13806F', fg: '#FFFFFF' },
];
const PARTIES = CONFIG.parties.slice(0, 3).map((p, i) => ({ ...p, ...COLORS[i] }));
const IDS = PARTIES.map((p) => p.id);
const P = Object.fromEntries(PARTIES.map((p) => [p.id, p]));
const CATS = ['Lodging', 'Food', 'Transport', 'Activities', 'Groceries', 'Other'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TITLES = { balances: 'Balances', add: 'Add expense', ledger: 'Ledger', settle: 'Settle up' };
const CUR = CONFIG.currency || '$';
const CODES = { '$': 'USD', '€': 'EUR', '£': 'GBP' };
const CLOUD_CONFIGURED = !!(CONFIG.supabaseUrl && CONFIG.supabaseAnonKey);

// ---------- helpers ----------
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (c) => CUR + (Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (c) => (c > 0 ? '+' : c < 0 ? '−' : '') + money(c);
const pad2 = (n) => (n < 10 ? '0' : '') + n;
const todayISO = () => { const d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); };
const fmtDay = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? MONTHS[+m[2] - 1] + ' ' + +m[3] : ''; };
const nameOf = (id) => (P[id] ? P[id].name : '?');
const initial = (id) => (String(nameOf(id)).trim().charAt(0) || '?').toUpperCase();
const av = (id, size = 'md') => P[id]
  ? `<span class="av av-${size}" style="background:${P[id].bg};color:${P[id].fg}" aria-hidden="true">${esc(initial(id))}</span>`
  : '';
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));
const joinNames = (ids) => ids.map(nameOf).join(' & ');

const ICON = {
  balances: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v16M7 20h10M5 8h14M5 8l-3 6a3 3 0 0 0 6 0zM19 8l-3 6a3 3 0 0 0 6 0z"/></svg>',
  ledger: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/></svg>',
  settle: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h15l-4-4M20 16H5l4 4"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>',
  camera: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  receipt: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h4"/></svg>',
  arrow: '<svg viewBox="0 0 28 20" aria-hidden="true"><path d="M2 10h22M18 4l6 6-6 6"/></svg>',
};

// ---------- trip id (kept in the URL hash, never in the repo) ----------
function readTripId() {
  const m = /(?:^|[#&])trip=([A-Za-z0-9_-]{16,64})/.exec(location.hash);
  if (m) { try { localStorage.setItem('tripsplit:lastTrip', m[1]); } catch {} return m[1]; }
  try { return localStorage.getItem('tripsplit:lastTrip') || ''; } catch { return ''; }
}
function newTripId() {
  const a = new Uint8Array(18);
  crypto.getRandomValues(a);
  return Array.from(a, (x) => 'abcdefghijklmnopqrstuvwxyz0123456789'[x % 36]).join('');
}

// ---------- state ----------
const blankForm = () => ({ amt: '', desc: '', date: todayISO(), cat: 'Food', payer: IDS[0], inc: Object.fromEntries(IDS.map((id) => [id, true])), mode: 'equal', custom: Object.fromEntries(IDS.map((id) => [id, ''])) });
const blankReceipt = () => ({ status: 'idle', blobUrl: '', ref: '', note: '' });

const state = {
  screen: 'balances',
  entries: [],
  filter: 'all',
  openId: null,
  form: blankForm(),
  receipt: blankReceipt(),
  viewUrl: '',
  toast: '',
  loading: true,
  error: '',
  needsTrip: false,
};
let store = null;
let toastTimer = 0;

function sorted(entries) {
  return entries.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || ''));
}

// ---------- form evaluation ----------
function evalForm() {
  const fm = state.form;
  const amt = cents(fm.amt);
  const inc = IDS.filter((id) => fm.inc[id]);
  let shares = {};
  if (fm.mode === 'equal') shares = splitEqual(amt, inc);
  else inc.forEach((id) => { shares[id] = cents(fm.custom[id]); });
  const assigned = inc.reduce((a, id) => a + (shares[id] || 0), 0);
  let msg = '';
  let valid = false;
  if (!amt) msg = 'Enter an amount.';
  else if (!inc.length) msg = 'Choose at least one party to share this cost.';
  else if (fm.mode === 'exact' && assigned !== amt) msg = assigned < amt ? `${money(amt - assigned)} of ${money(amt)} still to assign` : `${money(assigned - amt)} more than the total`;
  else if (!fm.desc.trim()) msg = 'Add a short description.';
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(fm.date)) msg = 'Pick a date.';
  else { valid = true; msg = `Ready. ${nameOf(fm.payer)} paid; ${inc.length === IDS.length ? 'shared by all three' : 'shared by ' + joinNames(inc)}.`; }
  return { amt, inc, shares, valid, msg };
}

// ---------- rendering ----------
function render() {
  const root = $('#app');
  const oldMain = $('#main');
  const keepScroll = oldMain && oldMain.dataset.screen === state.screen ? oldMain.scrollTop : 0;

  if (state.needsTrip) { root.innerHTML = setupHtml(); return; }

  const calc = computeBalances(state.entries, IDS);
  const tr = minimalTransfers(calc.net, IDS);
  root.innerHTML =
    headerHtml(calc) +
    `<main id="main" data-screen="${state.screen}">${
      state.loading ? '<p class="muted center pad">Loading…</p>'
      : state.error ? `<div class="card"><p class="strong">Couldn’t load the trip</p><p class="muted">${esc(state.error)}</p><button class="btn" data-action="reload">Try again</button></div>`
      : screenHtml(calc, tr)
    }</main>` +
    (state.toast ? `<div class="toast" role="status">${esc(state.toast)}</div>` : '') +
    navHtml() +
    viewerHtml();
  const main = $('#main');
  if (main) main.scrollTop = keepScroll;
  if (state.screen === 'add') updateAddLive();
}

function setupHtml() {
  return `<main id="main" class="setup">
    <h1>${esc(CONFIG.tripName)}</h1>
    <p>This app is connected to a shared database. Start a new trip, then send the link to the other two parties. Everyone uses the same link.</p>
    <button class="btn primary" data-action="newTrip">Start a new trip</button>
    <p class="muted">Already have a link? Open it on this phone and the trip loads.</p>
  </main>`;
}

function headerHtml(calc) {
  const sync = store ? (store.mode === 'cloud' ? 'Synced' : 'On this phone only') : '';
  return `<header class="top">
    <div class="top-row"><span class="trip">${esc(CONFIG.tripName)}</span><span class="sync">${esc(sync)}</span></div>
    <h1>${TITLES[state.screen]}</h1>
    <div class="tally" aria-label="Total spent per person">
      ${IDS.map((id) => `<div class="tcard"><span class="tname">${av(id, 'xs')}<span class="ellipsis">${esc(nameOf(id))}</span></span><span class="tamt num">${money(calc.b[id].paid)}</span><span class="tlbl">spent</span></div>`).join('')}
    </div>
  </header>`;
}

function navHtml() {
  const tab = (k, label, icon) => `<button type="button" class="tab${state.screen === k ? ' on' : ''}" data-action="go" data-screen="${k}" ${state.screen === k ? 'aria-current="page"' : ''}>${icon}${label}</button>`;
  return `<nav class="tabs" aria-label="Main">
    ${tab('balances', 'Balances', ICON.balances)}
    <button type="button" class="tab${state.screen === 'add' ? ' on' : ''}" data-action="go" data-screen="add" ${state.screen === 'add' ? 'aria-current="page"' : ''}><span class="addbubble">${ICON.plus}</span>Add</button>
    ${tab('ledger', 'Ledger', ICON.ledger)}
    ${tab('settle', 'Settle up', ICON.settle)}
  </nav>`;
}

function viewerHtml() {
  if (!state.viewUrl) return '';
  return `<div class="viewer" role="dialog" aria-label="Receipt photo">
    <div class="viewer-bar"><button type="button" class="btn ghost-dark" data-action="closeViewer">Close</button></div>
    <img src="${esc(state.viewUrl)}" alt="Receipt photo">
  </div>`;
}

function screenHtml(calc, tr) {
  switch (state.screen) {
    case 'add': return addHtml();
    case 'ledger': return ledgerHtml(calc);
    case 'settle': return settleHtml(calc, tr);
    default: return balancesHtml(calc, tr);
  }
}

function rowSub(e) {
  if (e.kind === 'payment') return 'Payment between parties';
  const sharers = IDS.filter((id) => (e.shares[id] || 0) > 0);
  return `Paid by ${nameOf(e.payer)} · ${sharers.length === IDS.length ? 'split by all three' : 'split by ' + joinNames(sharers)}${e.mode === 'exact' ? ' (custom)' : ''}`;
}
function rowTitle(e) { return e.kind === 'payment' ? `${nameOf(e.from)} → ${nameOf(e.to)}` : e.desc; }

function balancesHtml(calc, tr) {
  if (!state.entries.length) {
    return `<div class="stack">
      <div class="card center">
        <p class="strong big">No expenses yet</p>
        <p class="muted">Add the first one and everyone’s totals appear here.</p>
        <button class="btn primary" data-action="go" data-screen="add">Add first expense</button>
        ${store && store.mode === 'local' ? '<button class="btn" data-action="loadSample">Try it with sample data</button>' : ''}
      </div>
    </div>`;
  }
  const recent = sorted(state.entries).slice(0, 3);
  return `<div class="stack">
    <div class="card dark split">
      <div><span class="lbl-dark">Shared spending so far</span><span class="hero num">${money(calc.total)}</span></div>
      <span class="lbl-dark right">3 parties<br>${calc.expCount} expenses</span>
    </div>
    ${tr.length ? `<div class="card">
      <span class="lbl">If you squared up right now</span>
      ${tr.map((t) => `<div class="kv"><span>${esc(nameOf(t.from))} pays ${esc(nameOf(t.to))}</span><span class="strong num">${money(t.amount)}</span></div>`).join('')}
      <button class="btn" data-action="go" data-screen="settle">Open settle up</button>
    </div>` : '<div class="card"><span class="strong">Everyone is square right now.</span></div>'}
    <div class="section-head"><h2>Recent</h2><button class="link" data-action="go" data-screen="ledger">See full ledger</button></div>
    ${recent.map((e) => `<div class="card row-compact"><div class="grow"><span class="strong">${esc(rowTitle(e))}</span><span class="small muted">${esc(rowSub(e))}</span></div><span class="strong num">${money(e.amount)}</span></div>`).join('')}
  </div>`;
}

function chip(label, action, data, on, extra = '') {
  const attrs = Object.entries(data).map(([k, v]) => `data-${k}="${esc(v)}"`).join(' ');
  return `<button type="button" class="chip${on ? ' on' : ''}" data-action="${action}" ${attrs} aria-pressed="${on}" ${extra}>${label}</button>`;
}

function addHtml() {
  const fm = state.form;
  const r = state.receipt;
  const img = r.blobUrl || (r.ref && store ? store.receiptUrl(r.ref) : '');
  const receiptTitle = r.status === 'reading' ? 'Reading receipt…' : r.status === 'done' ? 'Receipt attached' : 'Scan a receipt';
  const receiptMsg = r.status === 'reading' ? 'Pulling out what it was, the date and the total.'
    : r.status === 'done' ? r.note
    : store && store.mode === 'cloud' ? 'Take a photo and the details fill in for you.' : 'Attach a photo. Auto-read works once the app is connected (see README).';
  return `<div class="stack gap-lg">
    <div class="card receipt">
      ${img
        ? `<button type="button" class="thumb" data-action="viewReceipt" data-url="${esc(img)}" aria-label="View receipt photo"><img src="${esc(img)}" alt=""></button>`
        : `<span class="thumb empty" aria-hidden="true">${ICON.receipt}</span>`}
      <div class="grow">
        <span class="strong">${receiptTitle}</span>
        <span class="small muted" role="status">${esc(receiptMsg)}</span>
        ${r.status === 'done' ? '<button type="button" class="link small" data-action="removeReceipt">Remove receipt</button>' : ''}
      </div>
      <label class="btn primary scan">${ICON.camera}${r.status === 'idle' ? 'Scan' : 'Retake'}
        <input id="receipt-input" type="file" accept="image/*" capture="environment" aria-label="Take or choose a receipt photo" ${r.status === 'reading' ? 'disabled' : ''}>
      </label>
    </div>

    <label class="card amount">
      <span class="lbl">Amount</span>
      <span class="amount-row"><span class="cur">${esc(CUR)}</span><input data-field="amt" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00" value="${esc(fm.amt)}"></span>
    </label>

    <label class="field"><span class="lbl">What was it?</span><input data-field="desc" type="text" maxlength="80" placeholder="e.g. Dinner at the harbor" value="${esc(fm.desc)}"></label>
    <label class="field"><span class="lbl">Date</span><input data-field="date" type="date" value="${esc(fm.date)}"></label>

    <div class="field"><span class="lbl">Category</span>
      <div class="wrap">${CATS.map((c) => chip(esc(c), 'cat', { cat: c }, fm.cat === c)).join('')}</div>
    </div>

    <div class="field"><span class="lbl">Who paid?</span>
      <div class="grid3">${IDS.map((id) => chip(av(id, 'sm') + esc(nameOf(id)), 'payer', { id }, fm.payer === id, 'style="height:52px"')).join('')}</div>
    </div>

    <div class="field"><span class="lbl">Who shares this cost?</span>
      <div class="grid3">${IDS.map((id) => chip((fm.inc[id] ? ICON.check : '') + esc(nameOf(id)), 'inc', { id }, !!fm.inc[id], 'style="height:52px"')).join('')}</div>
    </div>

    <div class="field"><span class="lbl">How is it split?</span>
      <div class="seg">
        <button type="button" class="${fm.mode === 'equal' ? 'on' : ''}" data-action="mode" data-mode="equal" aria-pressed="${fm.mode === 'equal'}">Equally</button>
        <button type="button" class="${fm.mode === 'exact' ? 'on' : ''}" data-action="mode" data-mode="exact" aria-pressed="${fm.mode === 'exact'}">Exact amounts</button>
      </div>
    </div>

    <div class="card tight">
      ${fm.mode === 'exact' ? IDS.filter((id) => fm.inc[id]).map((id) => `<div class="exact-row">${av(id, 'sm')}<span class="grow strong">${esc(nameOf(id))}</span><input data-field="custom" data-id="${id}" type="text" inputmode="decimal" aria-label="Amount for ${esc(nameOf(id))}" placeholder="0.00" value="${esc(fm.custom[id])}"></div>`).join('') : ''}
      <p id="add-status" class="status" role="status"></p>
    </div>

    <button id="save-btn" type="button" class="btn primary big" data-action="save">Save expense</button>
  </div>`;
}

function updateAddLive() {
  const r = evalForm();
  const st = $('#add-status');
  if (st) { st.textContent = r.msg; st.classList.toggle('ok', r.valid); }
  const b = $('#save-btn');
  if (b) b.disabled = !r.valid;
}

function ledgerHtml(calc) {
  const f = state.filter;
  const involves = (e, id) => (e.kind === 'payment' ? e.from === id || e.to === id : e.payer === id || (e.shares[id] || 0) > 0);
  const rows = sorted(state.entries).filter((e) => f === 'all' || involves(e, f));
  let focus = '';
  if (f !== 'all' && P[f]) {
    const partN = state.entries.filter((e) => e.kind !== 'payment' && (e.shares[f] || 0) > 0).length;
    focus = `<div class="card dark">
      <span class="tname strong">${av(f, 'sm')}${esc(nameOf(f))}</span>
      <div class="grid2">
        <div><span class="lbl-dark">Spent</span><span class="mid num">${money(calc.b[f].paid)}</span></div>
        <div><span class="lbl-dark">Benefitted</span><span class="mid num">${money(calc.b[f].share)}</span></div>
      </div>
      <span class="small lbl-dark-soft">Took part in ${partN} of ${calc.expCount} expenses</span>
    </div>`;
  }
  return `<div class="stack">
    <div class="wrap">${[['all', 'All']].concat(IDS.map((id) => [id, nameOf(id)])).map(([k, l]) => chip(esc(l), 'filter', { k }, f === k)).join('')}</div>
    ${focus}
    ${rows.length ? rows.map((e) => {
      const open = state.openId === e.id;
      const dots = (e.kind === 'payment' ? [e.from, e.to] : IDS.filter((id) => (e.shares[id] || 0) > 0)).map((id) => av(id, 'dot')).join('');
      const rurl = e.receipt && store ? store.receiptUrl(e.receipt) : '';
      const meta = `${fmtDay(e.date)} · ${e.kind === 'payment' ? 'Settle-up payment' : esc(e.cat)}${e.receipt ? ' · Receipt' : ''}`;
      return `<div class="card entry">
        <button type="button" class="entry-head" data-action="toggle" data-id="${esc(e.id)}" aria-expanded="${open}">
          <span class="grow"><span class="small muted">${meta}</span><span class="strong">${esc(rowTitle(e))}</span><span class="small muted">${esc(rowSub(e))}</span></span>
          <span class="entry-right"><span class="strong num">${money(e.amount)}</span><span class="dots">${dots}</span></span>
        </button>
        ${open ? `<div class="entry-body">
          ${rurl ? `<button type="button" class="link with-thumb" data-action="viewReceipt" data-url="${esc(rurl)}"><img src="${esc(rurl)}" alt="">View receipt</button>` : ''}
          <button type="button" class="btn danger" data-action="del" data-id="${esc(e.id)}">Delete entry</button>
        </div>` : ''}
      </div>`;
    }).join('') : '<p class="muted center pad">Nothing here yet.</p>'}
  </div>`;
}

function summaryText(calc, tr) {
  const lines = [CONFIG.tripName + ' — settle-up as of ' + fmtDay(todayISO()) + ':'];
  if (tr.length) tr.forEach((t) => lines.push(`• ${nameOf(t.from)} pays ${nameOf(t.to)} ${money(t.amount)}`));
  else lines.push('Everyone is square — no payments due.');
  lines.push('', 'Shared spending: ' + money(calc.total));
  IDS.forEach((id) => lines.push(`${nameOf(id)}: spent ${money(calc.b[id].paid)}, benefitted ${money(calc.b[id].share)}, net ${signed(calc.net[id])}`));
  return lines.join('\n');
}

function settleHtml(calc, tr) {
  const canShare = !!navigator.share;
  return `<div class="stack">
    ${tr.length ? `<p class="lead">${tr.length === 1 ? 'One payment settles' : tr.length + ' payments settle'} every balance.</p>
      ${tr.map((t, i) => `<div class="card">
        <div class="transfer">${av(t.from, 'lg')}<span class="arrow">${ICON.arrow}</span>${av(t.to, 'lg')}
          <span class="grow right"><span class="mid num">${money(t.amount)}</span><span class="small muted">${esc(nameOf(t.from))} pays ${esc(nameOf(t.to))}</span></span>
        </div>
        <button type="button" class="btn primary" data-action="record" data-i="${i}">Mark as paid</button>
      </div>`).join('')}`
    : `<div class="card center"><span class="ok-icon">${ICON.check}</span><span class="strong big">Everyone is square</span><span class="muted">No payments are due between parties.</span></div>`}

    <h2>Breakdown</h2>
    <div class="card tight">
      <div class="table head"><span>Party</span><span>Spent</span><span>Benefitted</span><span>Net</span></div>
      ${IDS.map((id) => `<div class="table num"><span class="strong">${esc(nameOf(id))}</span><span>${money(calc.b[id].paid)}</span><span>${money(calc.b[id].share)}</span><span class="strong">${signed(calc.net[id])}</span></div>`).join('')}
      <p class="small muted pad-y">Net = spent − benefitted, adjusted for settle-up payments already made.</p>
    </div>

    <h2>Share with the group</h2>
    <div class="card">
      <p class="summary num">${esc(summaryText(calc, tr))}</p>
      <button type="button" class="btn" data-action="share">${canShare ? 'Share summary' : 'Copy summary'}</button>
    </div>
    ${store && store.mode === 'local' && state.entries.length ? '<button type="button" class="link small center" data-action="clearLocal">Clear all data on this phone</button>' : ''}
  </div>`;
}

// ---------- actions ----------
function flash(msg) {
  clearTimeout(toastTimer);
  state.toast = msg;
  render();
  toastTimer = setTimeout(() => { state.toast = ''; softRender(); }, 2600);
}

// Background updates must not wipe a field someone is typing in (and close the phone keyboard).
function softRender() {
  const a = document.activeElement;
  if (a && a.matches && a.matches('main input')) {
    const t = $('.toast');
    if (!state.toast && t) t.remove();
    return;
  }
  render();
}

async function refresh() {
  try {
    state.entries = await store.list();
    state.error = '';
  } catch (err) {
    state.error = (err && err.message) || 'Network error';
  }
  state.loading = false;
  softRender();
}

async function persistAdd(entry, okMsg) {
  state.entries = state.entries.concat([entry]);
  flash(okMsg);
  try { await store.add(entry); }
  catch (err) {
    state.entries = state.entries.filter((e) => e.id !== entry.id);
    flash(err && err.message === 'storage_full' ? 'Phone storage is full — remove a receipt photo or two.' : 'Couldn’t save. Check your connection and try again.');
  }
}

const actions = {
  go(d) { state.screen = d.screen; state.openId = null; render(); $('#main') && ($('#main').scrollTop = 0); },
  reload() { state.loading = true; render(); refresh(); },
  filter(d) { state.filter = d.k; state.openId = null; render(); },
  toggle(d) { state.openId = state.openId === d.id ? null : d.id; render(); },
  async del(d) {
    const gone = state.entries.find((e) => e.id === d.id);
    if (!gone || !confirmDelete(gone)) return;
    state.entries = state.entries.filter((e) => e.id !== d.id);
    state.openId = null;
    flash('Entry deleted');
    try { await store.remove(d.id); } catch { state.entries = state.entries.concat([gone]); flash('Couldn’t delete. Try again.'); }
  },
  viewReceipt(d) { state.viewUrl = d.url; render(); },
  closeViewer() { state.viewUrl = ''; render(); },
  cat(d) { state.form.cat = d.cat; render(); },
  payer(d) { state.form.payer = d.id; render(); },
  inc(d) { state.form.inc[d.id] = !state.form.inc[d.id]; render(); },
  mode(d) {
    const fm = state.form;
    if (d.mode === 'exact' && fm.mode !== 'exact') {
      const incl = IDS.filter((id) => fm.inc[id]);
      const eq = splitEqual(cents(fm.amt), incl);
      fm.custom = Object.fromEntries(IDS.map((id) => [id, eq[id] ? (eq[id] / 100).toFixed(2) : '']));
    }
    fm.mode = d.mode;
    render();
  },
  async save() {
    const r = evalForm();
    if (!r.valid) return;
    const fm = state.form;
    const shares = {};
    r.inc.forEach((id) => { if (r.shares[id] > 0) shares[id] = r.shares[id]; });
    const entry = { id: uuid(), kind: 'expense', desc: fm.desc.trim(), cat: fm.cat, date: fm.date, amount: r.amt, payer: fm.payer, shares, mode: fm.mode, receipt: state.receipt.ref || '', createdAt: new Date().toISOString() };
    if (state.receipt.blobUrl) URL.revokeObjectURL(state.receipt.blobUrl);
    state.form = blankForm();
    state.receipt = blankReceipt();
    state.screen = 'balances';
    await persistAdd(entry, `Added “${entry.desc}” · ${money(entry.amount)}`);
  },
  async record(d) {
    const calc = computeBalances(state.entries, IDS);
    const t = minimalTransfers(calc.net, IDS)[Number(d.i)];
    if (!t) return;
    const entry = { id: uuid(), kind: 'payment', from: t.from, to: t.to, amount: t.amount, date: todayISO(), shares: {}, createdAt: new Date().toISOString() };
    await persistAdd(entry, `Recorded: ${nameOf(t.from)} paid ${nameOf(t.to)} ${money(t.amount)}`);
  },
  async share() {
    const calc = computeBalances(state.entries, IDS);
    const text = summaryText(calc, minimalTransfers(calc.net, IDS));
    if (navigator.share) { try { await navigator.share({ text }); } catch {} return; }
    try { await navigator.clipboard.writeText(text); flash('Summary copied'); } catch { flash('Copy blocked — select the text instead'); }
  },
  removeReceipt() { if (state.receipt.blobUrl) URL.revokeObjectURL(state.receipt.blobUrl); state.receipt = blankReceipt(); render(); },
  async loadSample() { const s = sampleEntries(); await store.addMany(s); await refresh(); },
  async clearLocal() {
    if (!window.confirm('Delete every expense and receipt stored on this phone?')) return;
    await store.clear(); await refresh();
  },
  newTrip() {
    const id = newTripId();
    location.hash = 'trip=' + id;
    location.reload();
  },
};

function confirmDelete(e) {
  return window.confirm(`Delete “${rowTitle(e)}” (${money(e.amount)}) for everyone?`);
}

// ---------- receipt capture ----------
function toJpeg(file, max = 1600, quality = 0.85) {
  return new Promise((resolve) => {
    const u = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const sc = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * sc);
        c.height = Math.round(img.naturalHeight * sc);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(u);
        c.toBlob((b) => resolve(b || file), 'image/jpeg', quality);
      } catch { URL.revokeObjectURL(u); resolve(file); }
    };
    img.onerror = () => { URL.revokeObjectURL(u); resolve(file); };
    img.src = u;
  });
}

async function handleReceipt(file) {
  if (!file) return;
  if (state.receipt.blobUrl) URL.revokeObjectURL(state.receipt.blobUrl);
  state.receipt = { status: 'reading', blobUrl: URL.createObjectURL(file), ref: '', note: '' };
  render();
  const cloud = store.mode === 'cloud';
  // Local mode stores a smaller image so localStorage doesn't fill up.
  const blob = await toJpeg(file, cloud ? 1600 : 1000, cloud ? 0.85 : 0.7);
  const [ref, data] = await Promise.all([
    store.uploadReceipt(blob).catch(() => ''),
    store.extract(blob).catch(() => null),
  ]);
  const patch = {};
  const got = [];
  if (data && typeof data === 'object') {
    const t = Number(data.total);
    if (data.total != null && Number.isFinite(t) && t > 0) { patch.amt = t.toFixed(2); got.push('amount'); }
    if (typeof data.description === 'string' && data.description.trim()) { patch.desc = data.description.trim().slice(0, 80); got.push('description'); }
    if (typeof data.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.date)) { patch.date = data.date; got.push('date'); }
    if (CATS.includes(data.category)) patch.cat = data.category;
  }
  let note;
  if (!cloud) note = 'Photo attached. Enter the details below.';
  else if (!data) note = 'Couldn’t read this receipt. Enter the details below.';
  else if (!got.length) note = 'Nothing readable found. Enter the details below.';
  else note = `Filled in ${got.join(', ')}. Check before saving.`;
  const code = CODES[CUR];
  if (data && typeof data.currency === 'string' && code && data.currency.toUpperCase() !== code) note += ` Receipt is in ${data.currency.toUpperCase()}; convert if needed.`;
  if (!ref) note += ' The photo couldn’t be saved.';
  Object.assign(state.form, patch);
  state.receipt = { ...state.receipt, status: 'done', ref, note };
  render();
}

// ---------- sample data (local demo only) ----------
function sampleEntries() {
  const [A, B, C] = IDS;
  const y = new Date().getFullYear();
  const mk = (o) => ({ id: uuid(), createdAt: new Date().toISOString(), shares: {}, receipt: '', ...o });
  return [
    mk({ kind: 'expense', desc: 'Apartment, 7 nights', cat: 'Lodging', date: `${y}-10-10`, amount: 186000, payer: A, mode: 'equal', shares: { [A]: 62000, [B]: 62000, [C]: 62000 } }),
    mk({ kind: 'expense', desc: 'Rental car', cat: 'Transport', date: `${y}-10-10`, amount: 41250, payer: B, mode: 'equal', shares: { [A]: 13750, [B]: 13750, [C]: 13750 } }),
    mk({ kind: 'expense', desc: 'Market groceries', cat: 'Groceries', date: `${y}-10-11`, amount: 9630, payer: C, mode: 'equal', shares: { [A]: 3210, [B]: 3210, [C]: 3210 } }),
    mk({ kind: 'expense', desc: 'Dinner out', cat: 'Food', date: `${y}-10-12`, amount: 14800, payer: B, mode: 'equal', shares: { [B]: 7400, [C]: 7400 } }),
    mk({ kind: 'expense', desc: 'Show tickets', cat: 'Activities', date: `${y}-10-13`, amount: 9000, payer: C, mode: 'equal', shares: { [A]: 4500, [C]: 4500 } }),
    mk({ kind: 'expense', desc: 'Surf lessons', cat: 'Activities', date: `${y}-10-14`, amount: 21000, payer: C, mode: 'exact', shares: { [B]: 14000, [C]: 7000 } }),
    mk({ kind: 'payment', from: C, to: A, amount: 20000, date: `${y}-10-15` }),
  ];
}

// ---------- events ----------
document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.action];
  if (fn) { ev.preventDefault(); fn({ ...el.dataset }); }
});
document.addEventListener('input', (ev) => {
  const el = ev.target;
  const f = el.dataset && el.dataset.field;
  if (!f) return;
  if (f === 'custom') state.form.custom[el.dataset.id] = el.value;
  else state.form[f] = el.value;
  updateAddLive();
});
document.addEventListener('change', (ev) => {
  if (ev.target.id === 'receipt-input') {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    handleReceipt(file);
  }
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && state.viewUrl) { state.viewUrl = ''; render(); }
});

// ---------- boot ----------
async function boot() {
  const tripId = readTripId();
  if (CLOUD_CONFIGURED && !tripId) { state.needsTrip = true; render(); return; }
  try {
    store = await createStore(CONFIG, tripId);
  } catch (err) {
    state.loading = false;
    state.error = 'Couldn’t reach the shared database. ' + ((err && err.message) || '');
    render();
    return;
  }
  render();
  await refresh();
  if (store.mode === 'cloud') {
    // Light polling keeps all three phones in step while the app is open.
    setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 15000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
  }
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => {}); });
}
boot();
