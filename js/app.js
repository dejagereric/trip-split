import { CONFIG } from './config.js';
import { cents, splitEqual, computeBalances, minimalTransfers, convert, convertShares } from './logic.js';
import { createStore } from './store.js';

// ---------- constants ----------
const PALETTE = ['#3346C8', '#F2A33A', '#13806F', '#B5365B', '#6C47C2', '#8DB33A', '#1F6FB2', '#C05621'];
// Currencies (ISO codes). Everything Frankfurter's daily rates cover; the common ones first.
const COMMON_CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'MXN', 'CHF', 'JPY', 'AUD'];
const ALL_CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'MXN', 'CHF', 'JPY', 'AUD', 'BGN', 'BRL', 'CNY', 'CZK', 'DKK', 'HKD', 'HUF', 'IDR', 'ILS', 'INR', 'ISK', 'KRW', 'MYR', 'NOK', 'NZD', 'PHP', 'PLN', 'RON', 'SEK', 'SGD', 'THB', 'TRY', 'ZAR'];
const LEGACY_SYMBOLS = { '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR', 'A$': 'AUD', 'C$': 'CAD' };
const toCode = (c) => (LEGACY_SYMBOLS[c] || (/^[A-Z]{3}$/.test(c || '') ? c : 'USD'));
const curName = (() => {
  let dn = null;
  try { dn = new Intl.DisplayNames(['en'], { type: 'currency' }); } catch {}
  return (code) => { try { return dn ? dn.of(code) : code; } catch { return code; } };
})();
const fmtCache = {};
const fmt = (code) => fmtCache[code] || (fmtCache[code] = new Intl.NumberFormat('en-US', { style: 'currency', currency: code }));
const curSymbol = (code) => { try { return fmt(code).formatToParts(0).find((x) => x.type === 'currency').value; } catch { return code; } };
// A trip's preferred currencies: its ledger currency plus the ones it expects, USD and EUR first by default.
function tripCurrencies(trip) {
  const ledger = toCode(trip?.currency);
  const list = (trip?.currencies && trip.currencies.length ? trip.currencies : ['USD', 'EUR']).map(toCode);
  if (!list.includes(ledger)) list.unshift(ledger);
  return list.filter((c, i) => list.indexOf(c) === i);
}
const CATS = ['Lodging', 'Food', 'Transport', 'Activities', 'Groceries', 'Other'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TRIP_SCREENS = ['balances', 'add', 'ledger', 'settle'];
const TITLES = { balances: 'Balances', add: 'Add expense', ledger: 'Ledger', settle: 'Settle up', trips: 'Trips', tripEdit: 'Trip', people: 'People', personEdit: 'Person', access: 'Access', me: 'Your details' };
const MANAGE_LISTS = ['trips', 'people', 'access'];
const CAN_PICK_CONTACTS = typeof navigator !== 'undefined' && 'contacts' in navigator && typeof navigator.contacts?.select === 'function';

// ---------- helpers ----------
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let CUR = toCode(CONFIG.defaultCurrency);
const money = (c, cur = CUR) => { try { return fmt(toCode(cur)).format(Math.abs(c) / 100); } catch { return toCode(cur) + ' ' + (Math.abs(c) / 100).toFixed(2); } };
const signed = (c) => (c > 0 ? '+' : c < 0 ? '−' : '') + money(c);
const pad2 = (n) => (n < 10 ? '0' : '') + n;
const todayISO = () => { const d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); };
const fmtDay = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ''); return m ? MONTHS[+m[2] - 1] + ' ' + +m[3] : ''; };
const fmtRange = (a, b) => (a && b ? `${fmtDay(a)} – ${fmtDay(b)}` : a ? 'From ' + fmtDay(a) : b ? 'Until ' + fmtDay(b) : '');
const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function fgFor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2] > 0.3 ? '#1B1A17' : '#FFFFFF';
}
const initials = (name) => {
  const w = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!w.length) return '?';
  return (w.length > 1 ? w[0][0] + w[w.length - 1][0] : w[0][0]).toUpperCase();
};

const ICON = {
  balances: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v16M7 20h10M5 8h14M5 8l-3 6a3 3 0 0 0 6 0zM19 8l-3 6a3 3 0 0 0 6 0z"/></svg>',
  ledger: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/></svg>',
  settle: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h15l-4-4M20 16H5l4 4"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>',
  camera: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  receipt: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h4"/></svg>',
  arrow: '<svg viewBox="0 0 28 20" aria-hidden="true"><path d="M2 10h22M18 4l6 6-6 6"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
  contacts: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="9" r="3.5"/><path d="M5.5 19a6.5 6.5 0 0 1 13 0"/></svg>',
};

const pref = {
  get(k) { try { return localStorage.getItem('tripsplit:' + k) || ''; } catch { return ''; } },
  set(k, v) { try { localStorage.setItem('tripsplit:' + k, v); } catch {} },
};

// ---------- state ----------
const blankForm = () => ({ amt: '', desc: '', date: todayISO(), cat: 'Food', payer: '', excl: {}, mode: 'equal', custom: {}, cur: '', rate: '', rateFor: '', rateDate: '', rateManual: false, curOpen: false });
const blankReceipt = () => ({ status: 'idle', blobUrl: '', ref: '', note: '' });

const state = {
  screen: 'balances',
  tripId: '',
  data: { trips: [], parties: [], entries: [] },
  filter: 'all',
  openId: null,
  form: blankForm(),
  editId: null,
  picker: null, // 'payer' | 'share' while the "add someone" panel is open
  newPerson: { name: '', phone: '', email: '' },
  receipt: blankReceipt(),
  tripForm: null,
  personForm: null,
  viewUrl: '',
  toast: '',
  loading: true,
  error: '',
  // sign-in (cloud mode): checking | signedOut | codeSent | noGroup | ready
  auth: 'checking',
  authEmail: '',
  authCode: '',
  authMsg: '',
  authBusy: false,
  groupName: 'Our trips',
  user: null,
  groups: [],
  members: [],
  newMember: '',
};
let store = null;
let toastTimer = 0;

// ---------- derived data ----------
const partyById = (id) => state.data.parties.find((p) => p.id === id);
const nameOf = (id) => partyById(id)?.name || 'Removed person';
const joinNames = (ids) => ids.map(nameOf).join(' & ');
const curTrip = () => state.data.trips.find((t) => t.id === state.tripId) || null;
const tripEntries = (tripId = state.tripId) => state.data.entries.filter((e) => e.tripId === tripId);
const entryPeople = (e) => (e.kind === 'payment' ? [e.from, e.to] : [e.payer, ...Object.keys(e.shares || {})]).filter(Boolean);
// The people a trip shows: its frequent participants, plus anyone still on one of its expenses.
function tripIds(trip = curTrip()) {
  if (!trip) return [];
  const ids = [...(trip.members || [])];
  tripEntries(trip.id).forEach((e) => entryPeople(e).forEach((id) => { if (!ids.includes(id)) ids.push(id); }));
  return ids.filter((id) => partyById(id));
}
// The signed-in user's own person record: the person whose email matches the sign-in email.
const myEmail = () => (state.user?.email || '').trim().toLowerCase();
const myPartyId = () => {
  const e = myEmail();
  if (!e) return '';
  const p = state.data.parties.find((x) => (x.email || '').trim().toLowerCase() === e);
  return p ? p.id : '';
};
// People offered on the Add expense form: the trip's people, plus you (so you're on new expenses by default).
function formIds() {
  const ids = tripIds();
  const me = myPartyId();
  if (me && !ids.includes(me)) ids.unshift(me);
  return ids;
}
const usesIn = (pid, entries) => entries.filter((e) => entryPeople(e).includes(pid)).length;
const sortTrips = (ts) => ts.slice().sort((a, b) => (b.start || b.createdAt || '').localeCompare(a.start || a.createdAt || ''));
const sortEntries = (es) => es.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || ''));

function av(id, size = 'md') {
  const p = partyById(id);
  if (!p) return `<span class="av av-${size}" style="background:#8A939D;color:#FFFFFF" aria-hidden="true">?</span>`;
  const bg = PALETTE[(p.color || 0) % PALETTE.length];
  return `<span class="av av-${size}" style="background:${bg};color:${fgFor(bg)}" aria-hidden="true">${esc(initials(p.name))}</span>`;
}

// ---------- form evaluation ----------
function evalForm() {
  const fm = state.form;
  const members = formIds();
  const cur = fm.cur || CUR;
  const foreign = cur !== CUR;
  const rate = foreign ? Number(String(fm.rate).replace(/[^0-9.]/g, '')) : 1;
  const hasRate = !foreign || (Number.isFinite(rate) && rate > 0);
  const origAmt = cents(fm.amt);                       // in the currency spent
  const amt = hasRate ? convert(origAmt, rate) : 0;    // in the trip's ledger currency
  const inc = members.filter((id) => !fm.excl[id]);
  let shares = {};
  let origShares = {};
  if (fm.mode === 'equal') shares = splitEqual(amt, inc);
  else {
    inc.forEach((id) => { origShares[id] = cents(fm.custom[id]); });
    shares = hasRate ? convertShares(origShares, rate, amt) : {};
  }
  const assigned = inc.reduce((a, id) => a + (origShares[id] || 0), 0);
  let msg = '';
  let valid = false;
  if (!members.length) msg = 'Add who paid to get started.';
  else if (!fm.payer || !members.includes(fm.payer)) msg = 'Choose who paid.';
  else if (!origAmt) msg = 'Enter an amount.';
  else if (!hasRate) msg = state.fxBusy ? `Getting the ${cur} → ${CUR} rate…` : `Enter the ${cur} → ${CUR} exchange rate.`;
  else if (!inc.length) msg = 'Choose at least one person to share this cost.';
  else if (fm.mode === 'exact' && assigned !== origAmt) msg = assigned < origAmt ? `${money(origAmt - assigned, cur)} of ${money(origAmt, cur)} still to assign` : `${money(assigned - origAmt, cur)} more than the total`;
  else if (!fm.desc.trim()) msg = 'Add a short description.';
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(fm.date)) msg = 'Pick a date.';
  else { valid = true; msg = `Ready. ${nameOf(fm.payer)} paid; ${inc.length === members.length && members.length > 1 ? 'shared by everyone' : 'shared by ' + joinNames(inc)}.`; }
  return { amt, origAmt, cur, foreign, rate: foreign ? rate : 1, hasRate, inc, shares, valid, msg };
}

// ---------- rendering ----------
function render() {
  const root = $('#app');
  const oldMain = $('#main');
  const keepScroll = oldMain && oldMain.dataset.screen === state.screen ? oldMain.scrollTop : 0;

  if (!store || (store.mode === 'cloud' && state.auth !== 'ready')) { root.innerHTML = authHtml(); focusAuth(); return; }

  const trip = curTrip();
  if (TRIP_SCREENS.includes(state.screen) && !trip && !state.loading) state.screen = 'trips';
  CUR = toCode(trip?.currency || CONFIG.defaultCurrency);
  const isTripScreen = TRIP_SCREENS.includes(state.screen);

  let body;
  if (state.loading) body = '<p class="muted center pad">Loading…</p>';
  else if (state.error) body = `<div class="card"><p class="strong">Couldn’t load your trips</p><p class="muted">${esc(state.error)}</p><button class="btn" data-action="reload">Try again</button></div>`;
  else body = screenHtml();

  let calc = null;
  if (isTripScreen && trip) calc = computeBalances(tripEntries(), tripIds());

  root.innerHTML =
    (isTripScreen ? tripHeaderHtml(trip, calc) : manageHeaderHtml(trip)) +
    `<main id="main" data-screen="${state.screen}">${body}</main>` +
    (state.toast ? `<div class="toast" role="status">${esc(state.toast)}</div>` : '') +
    (isTripScreen ? navHtml() : '') +
    viewerHtml();
  const main = $('#main');
  if (main) main.scrollTop = keepScroll;
  if (state.screen === 'add') updateAddLive();
}

function authHtml() {
  const busy = state.authBusy ? 'disabled' : '';
  const msg = state.authMsg ? `<p class="auth-msg" role="alert">${esc(state.authMsg)}</p>` : '';
  if (!store || state.auth === 'checking') return '<main id="main" class="setup"><h1>Trip Split</h1><p class="muted">Loading…</p></main>';
  if (state.auth === 'signedOut') {
    return `<main id="main" class="setup">
      <h1>Trip Split</h1>
      <p>Sign in with your email address. We’ll send you a 6-digit code — no password needed.</p>
      <label class="field"><span class="lbl">Email</span><input data-auth="authEmail" type="email" inputmode="email" autocomplete="email" autocapitalize="off" placeholder="you@example.com" value="${esc(state.authEmail)}"></label>
      <button type="button" class="btn primary big" data-action="sendCode" ${busy}>${state.authBusy ? 'Sending…' : 'Send code'}</button>
      ${msg}
      <p class="small muted">Only people added to a group can see its trips.</p>
    </main>`;
  }
  if (state.auth === 'codeSent') {
    return `<main id="main" class="setup">
      <h1>Check your email</h1>
      <p>Enter the code we sent to <strong>${esc(state.authEmail)}</strong>.</p>
      <label class="field"><span class="lbl">Code</span><input data-auth="authCode" class="code-input" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="123456" value="${esc(state.authCode)}"></label>
      <button type="button" class="btn primary big" data-action="verifyCode" ${busy}>${state.authBusy ? 'Checking…' : 'Sign in'}</button>
      ${msg}
      <div class="row-btns"><button type="button" class="link" data-action="sendCode" ${busy}>Send a new code</button><button type="button" class="link" data-action="changeEmail">Use a different email</button></div>
    </main>`;
  }
  // noGroup
  const me = state.user?.email || '';
  return `<main id="main" class="setup">
    <h1>Welcome</h1>
    <p>You’re signed in as <strong>${esc(me)}</strong>, but you’re not in a group yet.</p>
    <div class="card">
      <span class="strong">Joining someone else’s trips?</span>
      <span class="muted">Ask them to add <strong>${esc(me)}</strong> under Trips → Access, then tap Check again.</span>
      <button type="button" class="btn" data-action="checkGroups" ${busy}>Check again</button>
    </div>
    <div class="card">
      <span class="strong">Starting fresh?</span>
      <label class="field"><span class="lbl">Group name</span><input data-auth="groupName" type="text" maxlength="60" value="${esc(state.groupName)}"></label>
      <button type="button" class="btn primary" data-action="createGroup" ${busy}>Create our group</button>
    </div>
    ${msg}
    <button type="button" class="link center" data-action="signOut">Sign out</button>
  </main>`;
}

function focusAuth() {
  const el = $('[data-auth=authCode]') || $('[data-auth=authEmail]');
  if (el && !el.value) { try { el.focus(); } catch {} }
}

const syncLabel = () => (store ? (store.mode === 'cloud' ? (state.groups.find((g) => g.id === store.groupId)?.name || 'Synced') : 'On this phone only') : '');

function tripHeaderHtml(trip, calc) {
  const ids = tripIds(trip);
  return `<header class="top">
    <div class="top-row">
      <button type="button" class="trip-switch" data-action="go" data-screen="trips" aria-label="Switch trip, current trip ${esc(trip?.name || '')}"><span class="ellipsis">${esc(trip?.name || 'Trips')}</span>${ICON.chevron}</button>
      <span class="sync">${esc(syncLabel())}</span>
    </div>
    <h1>${state.screen === 'add' && state.editId ? 'Edit expense' : TITLES[state.screen]}</h1>
    ${calc && ids.length ? `<div class="tally" aria-label="Total spent per person">
      ${ids.map((id) => `<div class="tcard"><span class="tname">${av(id, 'xs')}<span class="ellipsis">${esc(nameOf(id))}</span></span><span class="tamt num">${money(calc.b[id].paid)}</span><span class="tlbl">spent</span></div>`).join('')}
    </div>` : ''}
  </header>`;
}

function manageHeaderHtml(trip) {
  const inList = MANAGE_LISTS.includes(state.screen);
  const back = state.screen === 'me' ? '<span></span>' : inList
    ? (trip ? `<button type="button" class="back" data-action="go" data-screen="balances">${ICON.back}<span class="ellipsis">${esc(trip.name)}</span></button>` : '<span></span>')
    : `<button type="button" class="back" data-action="go" data-screen="${state.screen === 'tripEdit' ? 'trips' : 'people'}">${ICON.back}${state.screen === 'tripEdit' ? 'Trips' : 'People'}</button>`;
  const title = state.screen === 'tripEdit' ? (state.tripForm?.id ? 'Edit trip' : 'New trip')
    : state.screen === 'personEdit' ? (state.personForm?.id ? 'Edit person' : 'New person')
    : TITLES[state.screen];
  return `<header class="top">
    <div class="top-row">${back}<span class="sync">${esc(syncLabel())}</span></div>
    <h1>${title}</h1>
    ${inList ? `<div class="seg${store?.mode === 'cloud' ? ' seg3' : ''}" role="group" aria-label="Manage">
      <button type="button" class="${state.screen === 'trips' ? 'on' : ''}" data-action="go" data-screen="trips" aria-pressed="${state.screen === 'trips'}">Trips</button>
      <button type="button" class="${state.screen === 'people' ? 'on' : ''}" data-action="go" data-screen="people" aria-pressed="${state.screen === 'people'}">People</button>
      ${store?.mode === 'cloud' ? `<button type="button" class="${state.screen === 'access' ? 'on' : ''}" data-action="go" data-screen="access" aria-pressed="${state.screen === 'access'}">Access</button>` : ''}
    </div>` : ''}
  </header>`;
}

function navHtml() {
  const tab = (k, label, icon) => `<button type="button" class="tab${state.screen === k ? ' on' : ''}" data-action="go" data-screen="${k}" ${state.screen === k ? 'aria-current="page"' : ''}>${icon}${label}</button>`;
  return `<nav class="tabs" aria-label="Trip">
    ${tab('balances', 'Balances', ICON.balances)}
    <button type="button" class="tab${state.screen === 'add' ? ' on' : ''}" data-action="newExpense" ${state.screen === 'add' ? 'aria-current="page"' : ''}><span class="addbubble">${ICON.plus}</span>Add</button>
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

function screenHtml() {
  switch (state.screen) {
    case 'trips': return tripsHtml();
    case 'tripEdit': return tripEditHtml();
    case 'people': return peopleHtml();
    case 'personEdit': return personEditHtml();
    case 'me': return meHtml();
    case 'access': return accessHtml();
    case 'add': return addHtml();
    case 'ledger': return ledgerHtml();
    case 'settle': return settleHtml();
    default: return balancesHtml();
  }
}

const youTag = (id) => (id && id === myPartyId() ? '<span class="you">(you)</span>' : '');

function chip(label, action, data, on, extra = '') {
  const attrs = Object.entries(data).map(([k, v]) => `data-${k}="${esc(v)}"`).join(' ');
  return `<button type="button" class="chip${on ? ' on' : ''}" data-action="${action}" ${attrs} aria-pressed="${on}" ${extra}>${label}</button>`;
}

// ----- trips -----
function tripsHtml() {
  const trips = sortTrips(state.data.trips);
  return `<div class="stack">
    <button type="button" class="btn primary" data-action="newTrip">${ICON.plus}New trip</button>
    ${trips.length ? trips.map((t) => {
      const es = tripEntries(t.id);
      const calc = computeBalances(es, tripIds(t));
      const ids = tripIds(t);
      const current = t.id === state.tripId;
      return `<div class="card trip-card${current ? ' current' : ''}">
        <button type="button" class="trip-open" data-action="selectTrip" data-id="${esc(t.id)}">
          <span class="grow">
            <span class="strong big">${esc(t.name)}</span>
            <span class="small muted">${esc([fmtRange(t.start, t.end), plural(calc.expCount, 'expense', 'expenses'), money(calc.total, t.currency)].filter(Boolean).join(' · '))}</span>
          </span>
          ${current ? '<span class="badge">Current</span>' : ''}
        </button>
        <div class="trip-foot">
          <span class="dots">${ids.length ? ids.slice(0, 8).map((id) => av(id, 'dot')).join('') : '<span class="small muted">No one yet</span>'}</span>
          <button type="button" class="link" data-action="editTrip" data-id="${esc(t.id)}">Edit</button>
        </div>
      </div>`;
    }).join('') : `<div class="card center"><p class="strong big">No trips yet</p><p class="muted">Create a trip, then add expenses. People are added as you go.</p>
      ${store?.mode === 'local' ? '<button class="btn" data-action="loadSample">Try it with sample data</button>' : ''}</div>`}
  </div>`;
}

function tripEditHtml() {
  const f = state.tripForm;
  if (!f) return '';
  const trip = state.data.trips.find((t) => t.id === f.id);
  const es = trip ? tripEntries(trip.id) : [];
  const members = trip ? tripIds(trip) : [];
  return `<div class="stack gap-lg">
    <label class="field"><span class="lbl">Trip name</span><input data-tf="name" type="text" maxlength="60" placeholder="e.g. Lisbon, October" value="${esc(f.name)}"></label>
    <div class="grid2">
      <label class="field"><span class="lbl">Starts</span><input data-tf="start" type="date" value="${esc(f.start)}"></label>
      <label class="field"><span class="lbl">Ends</span><input data-tf="end" type="date" value="${esc(f.end)}"></label>
    </div>
    <div class="field"><span class="lbl">Trip currency</span>
      <span class="small muted">Balances and settle-up are in this currency. Expenses in other currencies are converted at that day’s rate.</span>
      ${es.length ? `<span class="strong">${esc(f.currency)} · ${esc(curName(f.currency))}</span><span class="small muted">Locked: this trip already has expenses.</span>`
        : `<select data-tf="currency" aria-label="Trip currency">${ALL_CURRENCIES.map((c) => `<option value="${c}" ${f.currency === c ? 'selected' : ''}>${c} · ${esc(curName(c))}</option>`).join('')}</select>`}
    </div>
    <div class="field"><span class="lbl">Currencies you’ll spend</span>
      <span class="small muted">These are offered first when adding an expense.</span>
      <div class="wrap">${Array.from(new Set([...COMMON_CURRENCIES, ...f.currencies])).map((c) => chip(esc(c), 'tripCur', { c }, f.currencies.includes(c) || c === f.currency, `aria-label="${esc(curName(c))}"`)).join('')}</div>
      <select data-action-change="tripCurAdd" aria-label="Add another currency"><option value="">Add another…</option>${ALL_CURRENCIES.filter((c) => !COMMON_CURRENCIES.includes(c) && !f.currencies.includes(c)).map((c) => `<option value="${c}">${c} · ${esc(curName(c))}</option>`).join('')}</select>
    </div>
    <button type="button" class="btn primary big" data-action="saveTrip">${trip ? 'Save trip' : 'Create trip'}</button>

    ${trip ? `<h2>Frequent participants</h2>
      <p class="small muted note">People join a trip automatically when you add them to one of its expenses. Remove anyone added by mistake.</p>
      <div class="card tight">
        ${members.length ? members.map((id) => {
          const n = usesIn(id, es);
          return `<div class="list-row">${av(id, 'md')}<span class="grow"><span class="strong">${esc(nameOf(id))}</span><span class="small muted">${n ? 'On ' + plural(n, 'entry', 'entries') + ' — edit those first to remove' : 'Not on any expenses'}</span></span>
            <button type="button" class="btn small-btn" data-action="removeMember" data-id="${esc(id)}" ${n ? 'disabled' : ''} aria-label="Remove ${esc(nameOf(id))} from this trip">Remove</button></div>`;
        }).join('') : '<p class="small muted pad-y">No one yet. Add people from the Add expense screen.</p>'}
      </div>
      <button type="button" class="btn danger" data-action="deleteTrip" data-id="${esc(trip.id)}">Delete trip${es.length ? ' and its ' + plural(es.length, 'entry', 'entries') : ''}</button>` : ''}
  </div>`;
}

// ----- people -----
function peopleHtml() {
  const ps = state.data.parties.slice().sort((a, b) => a.name.localeCompare(b.name));
  return `<div class="stack">
    <button type="button" class="btn primary" data-action="newPersonScreen">${ICON.plus}Add person</button>
    ${ps.length ? `<div class="card tight">${ps.map((p) => {
      const tripsIn = state.data.trips.filter((t) => tripIds(t).includes(p.id)).length;
      const contact = [p.phone, p.email].filter(Boolean).join(' · ');
      return `<button type="button" class="list-row as-button" data-action="editPerson" data-id="${esc(p.id)}">${av(p.id, 'md')}
        <span class="grow"><span class="strong">${esc(p.name)}${youTag(p.id)}</span><span class="small muted ellipsis">${esc(contact || 'No contact details')}</span></span>
        <span class="small muted">${plural(tripsIn, 'trip', 'trips')}</span></button>`;
    }).join('')}</div>` : '<div class="card center"><p class="strong big">No people yet</p><p class="muted">People are added when you put them on an expense, or here.</p></div>'}
  </div>`;
}

function personEditHtml() {
  const f = state.personForm;
  if (!f) return '';
  const p = f.id ? partyById(f.id) : null;
  const n = p ? usesIn(p.id, state.data.entries) : 0;
  return `<div class="stack gap-lg">
    ${CAN_PICK_CONTACTS ? `<button type="button" class="btn" data-action="fillFromContacts">${ICON.contacts}Fill in from contacts</button>` : ''}
    <label class="field"><span class="lbl">Name</span><input data-pf="name" type="text" maxlength="60" autocomplete="off" value="${esc(f.name)}"></label>
    <label class="field"><span class="lbl">Phone</span><input data-pf="phone" type="tel" autocomplete="off" placeholder="Optional" value="${esc(f.phone)}"></label>
    ${p && p.id === myPartyId()
      ? `<label class="field"><span class="lbl">Email</span><input type="email" value="${esc(f.email)}" readonly aria-readonly="true"><span class="small muted">Your sign-in email. It links this person to you.</span></label>`
      : `<label class="field"><span class="lbl">Email</span><input data-pf="email" type="email" autocomplete="off" placeholder="Optional" value="${esc(f.email)}"></label>`}
    <div class="field"><span class="lbl">Color</span>
      <div class="wrap">${PALETTE.map((c, i) => `<button type="button" class="swatch${f.color === i ? ' on' : ''}" data-action="personColor" data-i="${i}" style="background:${c}" aria-label="Color ${i + 1}" aria-pressed="${f.color === i}"></button>`).join('')}</div>
    </div>
    ${p && p.email && store?.mode === 'cloud' ? (isMember(p.email)
      ? `<p class="small muted note">${esc(p.email)} can sign in and see your trips.</p>`
      : `<button type="button" class="btn" data-action="grantAccess" data-email="${esc(p.email)}">Let ${esc(p.name)} sign in</button>`) : ''}
    <button type="button" class="btn primary big" data-action="savePerson">${p ? 'Save' : 'Add person'}</button>
    ${p ? `<button type="button" class="btn danger" data-action="deletePerson" data-id="${esc(p.id)}" ${n ? 'disabled' : ''}>Delete person</button>
      ${n ? `<p class="small muted note">${esc(p.name)} is on ${plural(n, 'entry', 'entries')}, so they can’t be deleted. Edit or delete those entries first.</p>` : ''}` : ''}
  </div>`;
}

// ----- your details (cloud, once per group) -----
function meHtml() {
  const f = state.meForm || { name: '', phone: '' };
  const unlinked = state.data.parties.filter((p) => !(p.email || '').trim());
  return `<div class="stack gap-lg">
    <p class="lead">So your group knows who you are. You’ll be added to expenses you enter, and you can take yourself off any of them.</p>
    ${CAN_PICK_CONTACTS ? `<button type="button" class="btn" data-action="meFromContacts">${ICON.contacts}Fill in from my contact card</button>` : ''}
    <label class="field"><span class="lbl">Your name</span><input data-mf="name" type="text" maxlength="60" autocomplete="name" autocapitalize="words" placeholder="e.g. Eric de Jager" value="${esc(f.name)}"></label>
    <label class="field"><span class="lbl">Your phone</span><input data-mf="phone" type="tel" autocomplete="tel" placeholder="Optional" value="${esc(f.phone)}"></label>
    <p class="small muted note">Tip: tap a field and your phone may offer to fill in your own name and number.</p>
    <label class="field"><span class="lbl">Email</span><input type="email" value="${esc(myEmail())}" readonly aria-readonly="true"></label>
    ${unlinked.length && !myPartyId() ? `<div class="field"><span class="lbl">Already on the list under another entry?</span>
      <div class="wrap">${unlinked.map((p) => chip(av(p.id, 'sm') + 'That’s me: ' + esc(p.name), 'claimParty', { id: p.id }, false)).join('')}</div></div>` : ''}
    <button type="button" class="btn primary big" data-action="saveMe">Save</button>
    <button type="button" class="link center" data-action="skipMe">Skip for now</button>
  </div>`;
}

// Opens "Your details" when you have no person record yet, or (once) when yours has no phone.
function needsMe() {
  if (!store || store.mode !== 'cloud' || !myEmail()) return false;
  const me = partyById(myPartyId());
  if (!me) return true;
  return !me.phone && !pref.get('askedDetails:' + store.groupId);
}
function openMe() {
  const me = partyById(myPartyId());
  state.meForm = { name: me?.name || '', phone: me?.phone || '' };
  state.screen = 'me';
}

// ----- access (cloud) -----
const isMember = (email) => state.members.some((m) => m.email === String(email || '').trim().toLowerCase());
const appUrl = () => location.origin + location.pathname;

function inviteLink(email) {
  const body = `I’ve added you to our trips in Trip Split.\n\nOpen ${appUrl()} and sign in with this email address (${email}). You’ll get a 6-digit code — no password.\n\nOn your phone, add it to your home screen: Safari → Share → Add to Home Screen, or Chrome → ⋮ → Install app.`;
  return `mailto:${esc(email)}?subject=${encodeURIComponent('Join our trips on Trip Split')}&body=${encodeURIComponent(body)}`;
}

function accessHtml() {
  const me = (state.user?.email || '').toLowerCase();
  const iOwn = state.members.some((m) => m.email === me && m.role === 'owner');
  const group = state.groups.find((g) => g.id === store.groupId);
  return `<div class="stack">
    <div class="card">
      <span class="lbl">Signed in as</span>
      <span class="strong">${esc(me)}</span>
      <span class="small muted">Group: ${esc(group?.name || '')}</span>
      <button type="button" class="btn" data-action="signOut">Sign out</button>
    </div>
    ${state.groups.length > 1 ? `<div class="field"><span class="lbl">Your groups</span><div class="wrap">${state.groups.map((g) => chip(esc(g.name), 'switchGroup', { id: g.id }, g.id === store.groupId)).join('')}</div></div>` : ''}
    <h2>Who can sign in</h2>
    <p class="small muted note">Only these email addresses can open this group’s trips. Each person signs in with a code sent to their address.</p>
    <div class="card tight">
      ${state.members.map((m) => {
        const mine = m.email === me;
        const canRemove = m.role !== 'owner' && (iOwn || mine);
        return `<div class="list-row"><span class="grow"><span class="strong ellipsis">${esc(m.email)}</span><span class="small muted">${m.role === 'owner' ? 'Owner' : 'Member'}${mine ? ' · you' : ''}</span></span>
          ${!mine ? `<a class="btn small-btn" href="${inviteLink(m.email)}">Invite</a>` : ''}
          ${canRemove ? `<button type="button" class="btn small-btn" data-action="removeMember" data-email="${esc(m.email)}">${mine ? 'Leave' : 'Remove'}</button>` : ''}</div>`;
      }).join('')}
    </div>
    <div class="newperson">
      <input data-nm="1" type="email" inputmode="email" autocomplete="off" autocapitalize="off" placeholder="Add an email address" aria-label="Email address to add" value="${esc(state.newMember)}">
      <button type="button" class="btn primary" data-action="addMember">Give access</button>
    </div>
    <p class="small muted note">After adding someone, tap Invite to email them the link.</p>
  </div>`;
}

const pendingSign = new Set();
function receiptSrc(ref) {
  if (!ref || !store) return '';
  const u = store.receiptUrl(ref);
  if (u) return u;
  if (!pendingSign.has(ref)) {
    pendingSign.add(ref);
    store.signReceipt(ref).then(() => { pendingSign.delete(ref); softRender(); }).catch(() => { pendingSign.delete(ref); });
  }
  return '';
}

// ----- balances -----
function rowSub(e) {
  if (e.kind === 'payment') return 'Payment between people';
  const sharers = Object.keys(e.shares || {}).filter((id) => e.shares[id] > 0);
  const all = tripIds();
  const everyone = sharers.length === all.length && all.length > 2;
  return `Paid by ${nameOf(e.payer)} · ${everyone ? 'split by everyone' : 'split by ' + joinNames(sharers)}${e.mode === 'exact' ? ' (custom)' : ''}`;
}
// Amount as spent, plus the trip-currency figure when it was a different currency.
function amountHtml(e) {
  if (e.origCurrency && e.origCurrency !== CUR && e.origAmount != null) {
    return `<span class="amt-stack"><span class="strong num">${money(e.origAmount, e.origCurrency)}</span><span class="small muted num">${money(e.amount)}</span></span>`;
  }
  return `<span class="strong num">${money(e.amount)}</span>`;
}
const rowTitle = (e) => (e.kind === 'payment' ? `${nameOf(e.from)} → ${nameOf(e.to)}` : e.desc);

function balancesHtml() {
  const es = tripEntries();
  const ids = tripIds();
  if (!es.length) {
    return `<div class="stack"><div class="card center">
      <p class="strong big">No expenses yet</p>
      <p class="muted">Add the first one. Whoever you put on it joins this trip.</p>
      <button class="btn primary" data-action="newExpense">Add first expense</button>
    </div></div>`;
  }
  const calc = computeBalances(es, ids);
  const tr = minimalTransfers(calc.net, ids);
  const recent = sortEntries(es).slice(0, 3);
  return `<div class="stack">
    <div class="card dark split">
      <div><span class="lbl-dark">Shared spending so far</span><span class="hero num">${money(calc.total)}</span></div>
      <span class="lbl-dark right">${plural(ids.length, 'person', 'people')}<br>${plural(calc.expCount, 'expense', 'expenses')}</span>
    </div>
    ${tr.length ? `<div class="card">
      <span class="lbl">If you squared up right now</span>
      ${tr.map((t) => `<div class="kv"><span>${esc(nameOf(t.from))} pays ${esc(nameOf(t.to))}</span><span class="strong num">${money(t.amount)}</span></div>`).join('')}
      <button class="btn" data-action="go" data-screen="settle">Open settle up</button>
    </div>` : '<div class="card"><span class="strong">Everyone is square right now.</span></div>'}
    <div class="section-head"><h2>Recent</h2><button class="link" data-action="go" data-screen="ledger">See full ledger</button></div>
    ${recent.map((e) => `<div class="card row-compact"><div class="grow"><span class="strong">${esc(rowTitle(e))}</span><span class="small muted">${esc(rowSub(e))}</span></div>${amountHtml(e)}</div>`).join('')}
  </div>`;
}

// ----- add / edit expense -----
function pickerHtml(forWhat) {
  const members = formIds();
  const others = state.data.parties.filter((p) => !members.includes(p.id)).sort((a, b) => a.name.localeCompare(b.name));
  const np = state.newPerson;
  return `<div class="card picker">
    <span class="lbl">${forWhat === 'payer' ? 'Who paid? Add them to this trip' : 'Add someone to this trip'}</span>
    ${others.length ? `<div class="wrap">${others.map((p) => chip(av(p.id, 'sm') + esc(p.name), 'pickPerson', { id: p.id }, false)).join('')}</div>` : ''}
    ${CAN_PICK_CONTACTS ? `<button type="button" class="btn" data-action="pickContact">${ICON.contacts}Choose from contacts</button>` : ''}
    <div class="newperson">
      <input data-np="name" type="text" maxlength="60" autocomplete="off" placeholder="${others.length || CAN_PICK_CONTACTS ? 'Or type a new name' : 'Name'}" aria-label="New person’s name" value="${esc(np.name)}">
      <div class="grid2">
        <input data-np="phone" type="tel" autocomplete="off" placeholder="Phone (optional)" aria-label="Phone" value="${esc(np.phone)}">
        <input data-np="email" type="email" autocomplete="off" placeholder="Email (optional)" aria-label="Email" value="${esc(np.email)}">
      </div>
      <button type="button" class="btn primary" data-action="createPerson">Add to trip</button>
    </div>
    ${members.length ? '<button type="button" class="link small" data-action="closePicker">Cancel</button>' : ''}
  </div>`;
}

function defaultCurrency() {
  const trip = curTrip();
  const last = pref.get('lastCur:' + state.tripId) || pref.get('lastCur');
  const allowed = tripCurrencies(trip);
  return last && (allowed.includes(last) || ALL_CURRENCIES.includes(last)) ? last : CUR;
}
function fxNote() {
  const fm = state.form;
  if (state.fxBusy) return 'Getting rate…';
  if (state.fxError && !fm.rate) return 'Couldn’t get the rate. Type it in.';
  if (fm.rateManual) return 'Your rate';
  return fm.rateDate ? `Rate for ${fmtDay(fm.rateDate)}` : '';
}
function fxConvText() {
  const r = evalForm();
  if (!r.foreign || !r.origAmt || !r.hasRate) return '';
  return `= ${money(r.amt)} in ${CUR}`;
}
// Fetch the day's rate when the currency or date changes (unless you typed your own rate).
let fxSeq = 0;
async function ensureRate() {
  const fm = state.form;
  const cur = fm.cur || CUR;
  if (cur === CUR || !store?.fxRate) return;
  const key = `${cur}:${CUR}:${fm.date}`;
  if (fm.rateFor === key || fm.rateManual) return;
  fm.rateFor = key;
  const seq = ++fxSeq;
  state.fxBusy = true; state.fxError = false;
  try {
    const r = await store.fxRate(cur, CUR, fm.date || todayISO());
    if (seq !== fxSeq || state.form !== fm) return;
    fm.rate = String(r.rate);
    fm.rateDate = r.date;
  } catch {
    if (seq !== fxSeq) return;
    state.fxError = true;
    fm.rateFor = '';
  }
  state.fxBusy = false;
  refreshFx();
}
// Update the rate row without a full re-render (keeps the keyboard open while typing).
function refreshFx() {
  const fm = state.form;
  const rateEl = $('#fx-rate');
  if (rateEl && document.activeElement !== rateEl) rateEl.value = fm.rate;
  const note = $('#fx-note'); if (note) note.textContent = fxNote();
  const conv = $('#fx-conv'); if (conv) conv.textContent = fxConvText();
  updateAddLive();
}

function addHtml() {
  const fm = state.form;
  const members = formIds();
  // New expenses default to you as the payer (or the trip's first person if you're not set up).
  if (!state.editId && (!fm.payer || !members.includes(fm.payer))) fm.payer = myPartyId() || members[0] || '';
  // ...and to the last currency used on this trip (or the trip's own currency).
  if (!fm.cur) fm.cur = defaultCurrency();
  const fmCur = fm.cur;
  ensureRate();
  const picker = state.picker || (!members.length ? 'payer' : null);
  const r = state.receipt;
  const img = r.blobUrl || receiptSrc(r.ref);
  const receiptTitle = r.status === 'reading' ? 'Reading receipt…' : r.status === 'done' ? 'Receipt attached' : 'Scan a receipt';
  const receiptMsg = r.status === 'reading' ? 'Pulling out what it was, the date and the total.'
    : r.status === 'done' ? r.note
    : store && store.mode === 'cloud' ? 'Take a photo and the details fill in for you.' : 'Attach a photo. Auto-read works once the app is connected (see README).';
  const addChip = (forWhat) => `<button type="button" class="chip add-chip${picker === forWhat ? ' on' : ''}" data-action="openPicker" data-for="${forWhat}" aria-expanded="${picker === forWhat}">${ICON.plus}Add person</button>`;
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

    <div class="card amount">
      <label class="lbl" for="amt-input">Amount</label>
      <span class="amount-row">
        <button type="button" class="cur-btn" data-action="toggleCur" aria-expanded="${!!fm.curOpen}" aria-label="Currency: ${esc(curName(fmCur))}. Change">${esc(fmCur)}${ICON.chevron}</button>
        <input id="amt-input" data-field="amt" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00" value="${esc(fm.amt)}">
      </span>
      ${fm.curOpen ? `<div class="cur-pick">
        <div class="wrap">${tripCurrencies(curTrip()).map((c) => chip(esc(c), 'pickCur', { c }, fmCur === c, `aria-label="${esc(curName(c))}"`)).join('')}</div>
        <label class="field"><span class="lbl">Other currency</span>
          <select data-action-change="pickCurSelect" aria-label="Other currency">
            <option value="">Choose…</option>
            ${ALL_CURRENCIES.filter((c) => !tripCurrencies(curTrip()).includes(c)).map((c) => `<option value="${c}">${c} · ${esc(curName(c))}</option>`).join('')}
          </select>
        </label>
      </div>` : ''}
      ${fmCur !== CUR ? `<div class="fx-row">
        <span class="small muted">1 ${esc(fmCur)} =</span>
        <input id="fx-rate" data-field="rate" type="text" inputmode="decimal" autocomplete="off" aria-label="Exchange rate, ${esc(CUR)} per ${esc(fmCur)}" placeholder="${state.fxBusy ? '…' : 'rate'}" value="${esc(fm.rate)}">
        <span class="small muted">${esc(CUR)}</span>
        <span id="fx-note" class="small muted fx-note">${esc(fxNote())}</span>
      </div>
      <span id="fx-conv" class="strong fx-conv">${esc(fxConvText())}</span>` : ''}
    </div>

    <label class="field"><span class="lbl">What was it?</span><input data-field="desc" type="text" maxlength="80" placeholder="e.g. Dinner at the harbor" value="${esc(fm.desc)}"></label>
    <label class="field"><span class="lbl">Date</span><input data-field="date" type="date" value="${esc(fm.date)}"></label>

    <div class="field"><span class="lbl">Category</span>
      <div class="wrap">${CATS.map((c) => chip(esc(c), 'cat', { cat: c }, fm.cat === c)).join('')}</div>
    </div>

    <div class="field"><span class="lbl">Who paid?</span>
      <div class="wrap">${members.map((id) => chip(av(id, 'sm') + esc(nameOf(id)) + youTag(id), 'payer', { id }, fm.payer === id, 'style="min-height:48px"')).join('')}${addChip('payer')}</div>
      ${picker === 'payer' ? pickerHtml('payer') : ''}
    </div>

    ${members.length ? `<div class="field"><span class="lbl">Who shares this cost?</span>
      <div class="wrap">${members.map((id) => chip((!fm.excl[id] ? ICON.check : '') + esc(nameOf(id)) + youTag(id), 'inc', { id }, !fm.excl[id], 'style="min-height:48px"')).join('')}${addChip('share')}</div>
      ${myPartyId() && members.includes(myPartyId()) ? `<span class="small muted">${fm.excl[myPartyId()] ? 'You’re not sharing this one.' : 'Entering this for others? Tap your name to take yourself off.'}</span>` : ''}
      ${picker === 'share' ? pickerHtml('share') : ''}
    </div>

    <div class="field"><span class="lbl">How is it split?</span>
      <div class="seg">
        <button type="button" class="${fm.mode === 'equal' ? 'on' : ''}" data-action="mode" data-mode="equal" aria-pressed="${fm.mode === 'equal'}">Equally</button>
        <button type="button" class="${fm.mode === 'exact' ? 'on' : ''}" data-action="mode" data-mode="exact" aria-pressed="${fm.mode === 'exact'}">Exact amounts</button>
      </div>
    </div>` : ''}

    <div class="card tight">
      ${fm.mode === 'exact' ? members.filter((id) => !fm.excl[id]).map((id) => `<div class="exact-row">${av(id, 'sm')}<span class="grow strong">${esc(nameOf(id))}</span><input data-field="custom" data-id="${esc(id)}" type="text" inputmode="decimal" aria-label="Amount for ${esc(nameOf(id))}" placeholder="0.00" value="${esc(fm.custom[id] || '')}"></div>`).join('') : ''}
      <p id="add-status" class="status" role="status"></p>
    </div>

    <button id="save-btn" type="button" class="btn primary big" data-action="save">${state.editId ? 'Save changes' : 'Save expense'}</button>
    ${state.editId ? '<button type="button" class="link center" data-action="cancelEdit">Cancel editing</button>' : ''}
  </div>`;
}

function updateAddLive() {
  const conv = $('#fx-conv'); if (conv) conv.textContent = fxConvText();
  const r = evalForm();
  const st = $('#add-status');
  if (st) { st.textContent = r.msg; st.classList.toggle('ok', r.valid); }
  const b = $('#save-btn');
  if (b) b.disabled = !r.valid;
}

// ----- ledger -----
function ledgerHtml() {
  const f = state.filter;
  const ids = tripIds();
  const es = tripEntries();
  const calc = computeBalances(es, ids);
  const rows = sortEntries(es).filter((e) => f === 'all' || entryPeople(e).includes(f));
  let focus = '';
  if (f !== 'all' && ids.includes(f)) {
    const partN = es.filter((e) => e.kind !== 'payment' && (e.shares[f] || 0) > 0).length;
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
    <div class="wrap">${[['all', 'All']].concat(ids.map((id) => [id, nameOf(id)])).map(([k, l]) => chip(esc(l), 'filter', { k }, f === k)).join('')}</div>
    ${focus}
    ${rows.length ? rows.map((e) => {
      const open = state.openId === e.id;
      const dots = (e.kind === 'payment' ? [e.from, e.to] : Object.keys(e.shares).filter((id) => e.shares[id] > 0)).map((id) => av(id, 'dot')).join('');
      const rurl = open ? receiptSrc(e.receipt) : '';
      const meta = `${fmtDay(e.date)} · ${e.kind === 'payment' ? 'Settle-up payment' : esc(e.cat)}${e.receipt ? ' · Receipt' : ''}`;
      return `<div class="card entry">
        <button type="button" class="entry-head" data-action="toggle" data-id="${esc(e.id)}" aria-expanded="${open}">
          <span class="grow"><span class="small muted">${meta}</span><span class="strong">${esc(rowTitle(e))}</span><span class="small muted">${esc(rowSub(e))}</span></span>
          <span class="entry-right">${amountHtml(e)}<span class="dots">${dots}</span></span>
        </button>
        ${open ? `<div class="entry-body">
          ${rurl ? `<button type="button" class="link with-thumb" data-action="viewReceipt" data-url="${esc(rurl)}"><img src="${esc(rurl)}" alt="">View receipt</button>` : e.receipt ? '<span class="small muted">Loading receipt…</span>' : ''}
          ${e.createdBy ? `<span class="small muted">Added by ${esc(addedBy(e.createdBy))}</span>` : ''}
          <div class="row-btns">
            ${e.kind === 'expense' ? `<button type="button" class="btn" data-action="editExpense" data-id="${esc(e.id)}">Edit</button>` : ''}
            <button type="button" class="btn danger" data-action="del" data-id="${esc(e.id)}">Delete</button>
          </div>
        </div>` : ''}
      </div>`;
    }).join('') : '<p class="muted center pad">Nothing here yet.</p>'}
  </div>`;
}

const addedBy = (email) => {
  if (email === myEmail()) return 'you';
  const p = state.data.parties.find((x) => (x.email || '').trim().toLowerCase() === email);
  return p ? p.name : email;
};

// ----- settle -----
function summaryText(trip, calc, tr, ids) {
  const lines = [trip.name + ' — settle-up as of ' + fmtDay(todayISO()) + ` (amounts in ${CUR}):`];
  if (tr.length) tr.forEach((t) => lines.push(`• ${nameOf(t.from)} pays ${nameOf(t.to)} ${money(t.amount)}`));
  else lines.push('Everyone is square — no payments due.');
  lines.push('', 'Shared spending: ' + money(calc.total));
  ids.forEach((id) => lines.push(`${nameOf(id)}: spent ${money(calc.b[id].paid)}, benefitted ${money(calc.b[id].share)}, net ${signed(calc.net[id])}`));
  return lines.join('\n');
}

function messageLink(t, trip) {
  const p = partyById(t.from);
  if (!p) return '';
  const body = `Hi ${p.name}, settling up for ${trip.name}: you owe ${nameOf(t.to)} ${money(t.amount)}.`;
  if (p.phone) return `<a class="btn" href="sms:${esc(p.phone.replace(/[^\d+]/g, ''))}?&body=${encodeURIComponent(body)}">Text ${esc(p.name)}</a>`;
  if (p.email) return `<a class="btn" href="mailto:${esc(p.email)}?subject=${encodeURIComponent(trip.name + ' settle-up')}&body=${encodeURIComponent(body)}">Email ${esc(p.name)}</a>`;
  return '';
}

function settleHtml() {
  const trip = curTrip();
  const ids = tripIds();
  const calc = computeBalances(tripEntries(), ids);
  const tr = minimalTransfers(calc.net, ids);
  const canShare = !!navigator.share;
  return `<div class="stack">
    ${tr.length ? `<p class="lead">${tr.length === 1 ? 'One payment settles' : tr.length + ' payments settle'} every balance.</p>
      ${tr.map((t, i) => `<div class="card">
        <div class="transfer">${av(t.from, 'lg')}<span class="arrow">${ICON.arrow}</span>${av(t.to, 'lg')}
          <span class="grow right"><span class="mid num">${money(t.amount)}</span><span class="small muted">${esc(nameOf(t.from))} pays ${esc(nameOf(t.to))}</span></span>
        </div>
        <div class="row-btns">${messageLink(t, trip)}<button type="button" class="btn primary grow-btn" data-action="record" data-i="${i}">Mark as paid</button></div>
      </div>`).join('')}`
    : `<div class="card center"><span class="ok-icon">${ICON.check}</span><span class="strong big">Everyone is square</span><span class="muted">No payments are due.</span></div>`}

    <h2>Breakdown</h2>
    <div class="card tight">
      <div class="table head"><span>Person</span><span>Spent</span><span>Benefitted</span><span>Net</span></div>
      ${ids.map((id) => `<div class="table num"><span class="strong ellipsis">${esc(nameOf(id))}</span><span>${money(calc.b[id].paid)}</span><span>${money(calc.b[id].share)}</span><span class="strong">${signed(calc.net[id])}</span></div>`).join('')}
      <p class="small muted pad-y">Net = spent − benefitted, adjusted for settle-up payments already made.</p>
    </div>

    <h2>Share with the group</h2>
    <div class="card">
      <p class="summary num">${esc(summaryText(trip, calc, tr, ids))}</p>
      <button type="button" class="btn" data-action="share">${canShare ? 'Share summary' : 'Copy summary'}</button>
    </div>
  </div>`;
}

// ---------- persistence helpers ----------
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
    if (store.mode === 'cloud') {
      const [data, members] = await Promise.all([store.load(), store.members()]);
      state.data = data;
      state.members = members;
      const me = (state.user?.email || '').toLowerCase();
      if (!members.some((m) => m.email === me)) { await enterGroup(); return; } // removed from this group
    } else {
      state.data = await store.load();
    }
    state.error = '';
    if (!curTrip()) {
      const fallback = sortTrips(state.data.trips)[0];
      state.tripId = fallback ? fallback.id : '';
      if (!fallback && TRIP_SCREENS.includes(state.screen)) state.screen = 'trips';
    }
  } catch (err) {
    if (store.mode === 'cloud' && (err?.status === 401 || /jwt|token|not authenticated/i.test(err?.message || '')) && !(await store.auth.user())) {
      state.auth = 'signedOut';
      state.authMsg = 'Your sign-in expired. Sign in again.';
      render();
      return;
    }
    state.error = (err && err.message) || 'Network error';
  }
  state.loading = false;
  softRender();
}

// After sign-in: open the last-used group, or ask to create/join one.
async function enterGroup() {
  state.authBusy = true;
  render();
  try {
    state.groups = await store.listGroups();
  } catch (err) {
    state.groups = [];
    state.authMsg = 'Couldn’t reach the database. ' + (err?.message || '');
  }
  state.authBusy = false;
  if (!state.groups.length) { state.auth = 'noGroup'; render(); return; }
  const last = pref.get('activeGroup');
  const g = state.groups.find((x) => x.id === last) || state.groups[0];
  store.useGroup(g.id);
  pref.set('activeGroup', g.id);
  state.auth = 'ready';
  state.authMsg = '';
  state.loading = true;
  state.tripId = pref.get('activeTrip:' + g.id);
  render();
  await refresh();
  if (!curTrip()) state.screen = 'trips';
  if (needsMe()) openMe();
  render();
  startPolling();
}

let polling = false;
function startPolling() {
  if (polling || store.mode !== 'cloud') return;
  polling = true;
  // Light polling keeps everyone's phones in step while the app is open.
  setInterval(() => { if (state.auth === 'ready' && document.visibilityState === 'visible') refresh(); }, 15000);
  document.addEventListener('visibilitychange', () => { if (state.auth === 'ready' && document.visibilityState === 'visible') refresh(); });
}

// Apply a change locally right away, then save; undo and explain if saving fails.
async function commit(apply, save, undo, okMsg) {
  apply();
  if (okMsg) flash(okMsg); else render();
  try { await save(); }
  catch (err) {
    undo();
    flash(err && err.message === 'storage_full' ? 'Phone storage is full — remove a receipt photo or two.' : 'Couldn’t save. Check your connection and try again.');
  }
}
const replaceIn = (key, item) => {
  const list = state.data[key];
  const i = list.findIndex((x) => x.id === item.id);
  state.data[key] = i >= 0 ? list.map((x) => (x.id === item.id ? item : x)) : list.concat([item]);
};
const removeFrom = (key, id) => { state.data[key] = state.data[key].filter((x) => x.id !== id); };
const snapshot = () => JSON.parse(JSON.stringify(state.data));

function selectTrip(id) {
  state.tripId = id;
  pref.set('activeTrip:' + (store ? store.groupId : ''), id);
  state.filter = 'all';
  state.openId = null;
  state.editId = null;
  state.form = blankForm();
  state.picker = null;
}

// Puts a person on the current trip's frequent-participant list (if not already) and on the form.
async function addToTrip(pid, forWhat) {
  const trip = curTrip();
  if (!trip) return;
  if (forWhat === 'payer') state.form.payer = pid;
  delete state.form.excl[pid];
  state.picker = null;
  state.newPerson = { name: '', phone: '', email: '' };
  if ((trip.members || []).includes(pid)) { render(); return; }
  const before = snapshot();
  const updated = { ...trip, members: [...(trip.members || []), pid] };
  await commit(() => replaceIn('trips', updated), () => store.saveTrip(updated), () => { state.data = before; }, `${nameOf(pid)} added to ${trip.name}`);
}

async function createParty(fields) {
  const name = String(fields.name || '').trim();
  if (!name) return null;
  const existing = state.data.parties.find((p) => p.name.trim().toLowerCase() === name.toLowerCase());
  if (existing) {
    // Same name: fill in any missing contact details rather than creating a duplicate.
    const merged = { ...existing, phone: existing.phone || fields.phone || '', email: existing.email || fields.email || '' };
    if (merged.phone !== existing.phone || merged.email !== existing.email) {
      replaceIn('parties', merged);
      try { await store.saveParty(merged); } catch {}
    }
    return existing.id;
  }
  const p = { id: uuid(), name: name.slice(0, 60), phone: String(fields.phone || '').trim(), email: String(fields.email || '').trim(), color: state.data.parties.length % PALETTE.length, createdAt: new Date().toISOString() };
  replaceIn('parties', p);
  try { await store.saveParty(p); }
  catch { removeFrom('parties', p.id); flash('Couldn’t save that person. Try again.'); return null; }
  return p.id;
}

// Contact Picker API: the phone shows its own contact list and returns only the one person chosen.
async function chooseContact() {
  try {
    const [c] = await navigator.contacts.select(['name', 'tel', 'email'], { multiple: false });
    if (!c) return null;
    return { name: (c.name && c.name[0]) || '', phone: (c.tel && c.tel[0]) || '', email: (c.email && c.email[0]) || '' };
  } catch { return null; }
}

function setFormCurrency(code) {
  const fm = state.form;
  fm.cur = code; fm.curOpen = false; fm.rateManual = false; fm.rateFor = ''; fm.rate = ''; fm.rateDate = '';
  state.fxError = false;
  const trip = curTrip();
  if (trip && !tripCurrencies(trip).includes(code)) {
    const updated = { ...trip, currencies: [...tripCurrencies(trip), code] };
    replaceIn('trips', updated);
    store.saveTrip(updated).catch(() => {});
  }
  render();
}

// ---------- actions ----------
const actions = {
  go(d) {
    if (TRIP_SCREENS.includes(d.screen) && !curTrip()) { state.screen = 'trips'; render(); return; }
    if (d.screen === 'add' && !state.editId) state.picker = null;
    state.screen = d.screen;
    state.openId = null;
    render();
    const m = $('#main'); if (m) m.scrollTop = 0;
  },
  reload() { state.loading = true; render(); refresh(); },
  newExpense() {
    if (state.editId) { state.editId = null; state.form = blankForm(); state.receipt = blankReceipt(); }
    state.picker = null;
    actions.go({ screen: 'add' });
  },

  // trips
  selectTrip(d) { selectTrip(d.id); state.screen = 'balances'; render(); },
  newTrip() { const c = toCode(CONFIG.defaultCurrency); state.tripForm = { id: null, name: '', start: '', end: '', currency: c, currencies: Array.from(new Set([c, 'USD', 'EUR'])) }; state.screen = 'tripEdit'; render(); },
  editTrip(d) {
    const t = state.data.trips.find((x) => x.id === d.id);
    if (!t) return;
    state.tripForm = { id: t.id, name: t.name, start: t.start || '', end: t.end || '', currency: toCode(t.currency), currencies: tripCurrencies(t) };
    state.screen = 'tripEdit';
    render();
  },
  tripCur(d) {
    const f = state.tripForm;
    if (d.c === f.currency) return; // the trip currency is always offered
    f.currencies = f.currencies.includes(d.c) ? f.currencies.filter((c) => c !== d.c) : f.currencies.concat([d.c]);
    render();
  },
  tripCurAdd(d) { const f = state.tripForm; if (d.value && !f.currencies.includes(d.value)) f.currencies = f.currencies.concat([d.value]); render(); },

  // currency on an expense
  toggleCur() { state.form.curOpen = !state.form.curOpen; render(); },
  pickCur(d) { setFormCurrency(d.c); },
  pickCurSelect(d) { if (d.value) setFormCurrency(d.value); },
  async saveTrip() {
    const f = state.tripForm;
    const name = f.name.trim();
    if (!name) { flash('Give the trip a name.'); return; }
    if (f.start && f.end && f.end < f.start) { flash('The end date is before the start date.'); return; }
    const old = state.data.trips.find((t) => t.id === f.id);
    const currencies = Array.from(new Set([f.currency, ...f.currencies]));
    const trip = old ? { ...old, name, start: f.start, end: f.end, currency: f.currency, currencies }
      : { id: uuid(), name, start: f.start, end: f.end, currency: f.currency, currencies, members: myPartyId() ? [myPartyId()] : [], createdAt: new Date().toISOString() };
    const before = snapshot();
    await commit(() => {
      replaceIn('trips', trip);
      if (!old) { selectTrip(trip.id); state.screen = 'add'; } else state.screen = 'trips';
    }, () => store.saveTrip(trip), () => { state.data = before; }, old ? 'Trip saved' : `${name} created. Add the first expense.`);
  },
  async removeMember(d) {
    const trip = state.data.trips.find((t) => t.id === state.tripForm?.id);
    if (!trip || usesIn(d.id, tripEntries(trip.id))) return;
    const updated = { ...trip, members: (trip.members || []).filter((id) => id !== d.id) };
    const before = snapshot();
    await commit(() => replaceIn('trips', updated), () => store.saveTrip(updated), () => { state.data = before; }, `${nameOf(d.id)} removed from ${trip.name}`);
  },
  async deleteTrip(d) {
    const trip = state.data.trips.find((t) => t.id === d.id);
    if (!trip) return;
    const n = tripEntries(trip.id).length;
    if (!window.confirm(`Delete “${trip.name}”${n ? ' and its ' + plural(n, 'entry', 'entries') : ''} for everyone? This can’t be undone.`)) return;
    const before = snapshot();
    await commit(() => {
      removeFrom('trips', trip.id);
      state.data.entries = state.data.entries.filter((e) => e.tripId !== trip.id);
      if (state.tripId === trip.id) { const next = sortTrips(state.data.trips)[0]; selectTrip(next ? next.id : ''); }
      state.screen = 'trips';
    }, () => store.deleteTrip(trip.id), () => { state.data = before; }, 'Trip deleted');
  },

  // people
  newPersonScreen() { state.personForm = { id: null, name: '', phone: '', email: '', color: state.data.parties.length % PALETTE.length }; state.screen = 'personEdit'; render(); },
  editPerson(d) {
    const p = partyById(d.id);
    if (!p) return;
    state.personForm = { id: p.id, name: p.name, phone: p.phone || '', email: p.email || '', color: p.color || 0 };
    state.screen = 'personEdit';
    render();
  },
  personColor(d) { state.personForm.color = Number(d.i); render(); },
  async fillFromContacts() {
    const c = await chooseContact();
    if (!c) return;
    Object.assign(state.personForm, { name: c.name || state.personForm.name, phone: c.phone || state.personForm.phone, email: c.email || state.personForm.email });
    render();
  },
  async savePerson() {
    const f = state.personForm;
    const name = f.name.trim();
    if (!name) { flash('Enter a name.'); return; }
    const dup = state.data.parties.find((p) => p.id !== f.id && p.name.trim().toLowerCase() === name.toLowerCase());
    if (dup) { flash(`There’s already someone called ${dup.name}.`); return; }
    const old = f.id ? partyById(f.id) : null;
    const p = { ...(old || { id: uuid(), createdAt: new Date().toISOString() }), name, phone: f.phone.trim(), email: f.email.trim(), color: f.color };
    const before = snapshot();
    await commit(() => { replaceIn('parties', p); state.screen = 'people'; }, () => store.saveParty(p), () => { state.data = before; }, old ? 'Saved' : `${name} added`);
  },
  async deletePerson(d) {
    const p = partyById(d.id);
    if (!p || usesIn(p.id, state.data.entries)) return;
    if (!window.confirm(`Delete ${p.name}? They’ll also be removed from any trips they’re listed on.`)) return;
    const before = snapshot();
    const touched = state.data.trips.filter((t) => (t.members || []).includes(p.id)).map((t) => ({ ...t, members: t.members.filter((id) => id !== p.id) }));
    await commit(() => {
      removeFrom('parties', p.id);
      touched.forEach((t) => replaceIn('trips', t));
      state.screen = 'people';
    }, async () => { for (const t of touched) await store.saveTrip(t); await store.deleteParty(p.id); }, () => { state.data = before; }, `${p.name} deleted`);
  },

  // add / edit expense
  openPicker(d) { state.picker = state.picker === d.for ? null : d.for; render(); const i = $('[data-np=name]'); if (i && !CAN_PICK_CONTACTS) i.focus(); },
  closePicker() { state.picker = null; render(); },
  async pickPerson(d) { await addToTrip(d.id, state.picker || (tripIds().length ? 'share' : 'payer')); },
  async createPerson() {
    const forWhat = state.picker || (tripIds().length ? 'share' : 'payer');
    if (!state.newPerson.name.trim()) { flash('Type a name first.'); return; }
    const pid = await createParty(state.newPerson);
    if (pid) await addToTrip(pid, forWhat);
  },
  async pickContact() {
    const forWhat = state.picker || (tripIds().length ? 'share' : 'payer');
    const c = await chooseContact();
    if (!c || !c.name) return;
    const pid = await createParty(c);
    if (pid) await addToTrip(pid, forWhat);
  },
  cat(d) { state.form.cat = d.cat; render(); },
  payer(d) { state.form.payer = d.id; render(); },
  inc(d) { if (state.form.excl[d.id]) delete state.form.excl[d.id]; else state.form.excl[d.id] = true; render(); },
  mode(d) {
    const fm = state.form;
    if (d.mode === 'exact' && fm.mode !== 'exact') {
      const incl = formIds().filter((id) => !fm.excl[id]);
      const eq = splitEqual(cents(fm.amt), incl); // in the currency spent
      fm.custom = Object.fromEntries(incl.map((id) => [id, eq[id] ? (eq[id] / 100).toFixed(2) : '']));
    }
    fm.mode = d.mode;
    render();
  },
  editExpense(d) {
    const e = state.data.entries.find((x) => x.id === d.id);
    if (!e || e.kind !== 'expense') return;
    const members = formIds();
    state.editId = e.id;
    state.form = {
      ...blankForm(),
      amt: ((e.origAmount ?? e.amount) / 100).toFixed(2), desc: e.desc, date: e.date, cat: e.cat, payer: e.payer,
      excl: Object.fromEntries(members.filter((id) => !(e.shares[id] > 0)).map((id) => [id, true])),
      mode: e.mode === 'exact' ? 'exact' : 'equal',
      // Exact shares were stored converted; show them back in the currency spent.
      custom: Object.fromEntries(Object.entries(e.shares).map(([id, c]) => [id, (c / (e.fxRate || 1) / 100).toFixed(2)])),
      cur: e.origCurrency || CUR,
      rate: e.fxRate ? String(e.fxRate) : '',
      rateDate: e.fxDate || '',
      rateFor: e.origCurrency ? `${e.origCurrency}:${CUR}:${e.date}` : '',
    };
    state.receipt = e.receipt ? { status: 'done', blobUrl: '', ref: e.receipt, note: 'Saved with this expense.' } : blankReceipt();
    state.picker = null;
    state.screen = 'add';
    render();
    const m = $('#main'); if (m) m.scrollTop = 0;
  },
  cancelEdit() { state.editId = null; state.form = blankForm(); state.receipt = blankReceipt(); state.screen = 'ledger'; render(); },
  async save() {
    const r = evalForm();
    if (!r.valid) return;
    const fm = state.form;
    const shares = {};
    r.inc.forEach((id) => { if (r.shares[id] > 0) shares[id] = r.shares[id]; });
    const old = state.editId ? state.data.entries.find((x) => x.id === state.editId) : null;
    const entry = {
      ...(old || { id: uuid(), createdAt: new Date().toISOString() }),
      tripId: state.tripId, kind: 'expense', desc: fm.desc.trim(), cat: fm.cat, date: fm.date,
      amount: r.amt, payer: fm.payer, shares, mode: fm.mode, receipt: state.receipt.ref || '',
      origAmount: r.foreign ? r.origAmt : null, origCurrency: r.foreign ? r.cur : null,
      fxRate: r.foreign ? r.rate : null, fxDate: r.foreign ? (fm.rateManual ? fm.date : fm.rateDate || fm.date) : null,
    };
    pref.set('lastCur:' + state.tripId, r.cur);
    pref.set('lastCur', r.cur);
    if (state.receipt.blobUrl) URL.revokeObjectURL(state.receipt.blobUrl);
    const trip = curTrip();
    const joining = [fm.payer, ...Object.keys(shares)].filter((id, i, a) => id && a.indexOf(id) === i && !(trip.members || []).includes(id));
    const tripAfter = joining.length ? { ...trip, members: [...(trip.members || []), ...joining] } : null;
    const before = snapshot();
    await commit(() => {
      if (tripAfter) replaceIn('trips', tripAfter);
      replaceIn('entries', entry);
      state.form = blankForm();
      state.receipt = blankReceipt();
      state.editId = null;
      state.picker = null;
      state.screen = old ? 'ledger' : 'balances';
    }, async () => { if (tripAfter) await store.saveTrip(tripAfter); await store.saveEntry(entry); }, () => { state.data = before; }, old ? 'Changes saved' : `Added “${entry.desc}” · ${r.foreign ? money(r.origAmt, r.cur) + ' (' + money(entry.amount) + ')' : money(entry.amount)}`);
  },

  // ledger
  filter(d) { state.filter = d.k; state.openId = null; render(); },
  toggle(d) { state.openId = state.openId === d.id ? null : d.id; render(); },
  async del(d) {
    const gone = state.data.entries.find((e) => e.id === d.id);
    if (!gone || !window.confirm(`Delete “${rowTitle(gone)}” (${money(gone.amount)}) for everyone?`)) return;
    const before = snapshot();
    await commit(() => { removeFrom('entries', d.id); state.openId = null; }, () => store.deleteEntry(d.id), () => { state.data = before; }, 'Entry deleted');
  },
  viewReceipt(d) { state.viewUrl = d.url; render(); },
  closeViewer() { state.viewUrl = ''; render(); },
  removeReceipt() { if (state.receipt.blobUrl) URL.revokeObjectURL(state.receipt.blobUrl); state.receipt = blankReceipt(); render(); },

  // settle
  async record(d) {
    const ids = tripIds();
    const calc = computeBalances(tripEntries(), ids);
    const t = minimalTransfers(calc.net, ids)[Number(d.i)];
    if (!t) return;
    const entry = { id: uuid(), tripId: state.tripId, kind: 'payment', from: t.from, to: t.to, amount: t.amount, date: todayISO(), shares: {}, createdAt: new Date().toISOString() };
    const before = snapshot();
    await commit(() => replaceIn('entries', entry), () => store.saveEntry(entry), () => { state.data = before; }, `Recorded: ${nameOf(t.from)} paid ${nameOf(t.to)} ${money(t.amount)}`);
  },
  async share() {
    const trip = curTrip();
    const ids = tripIds();
    const calc = computeBalances(tripEntries(), ids);
    const text = summaryText(trip, calc, minimalTransfers(calc.net, ids), ids);
    if (navigator.share) { try { await navigator.share({ text }); } catch {} return; }
    try { await navigator.clipboard.writeText(text); flash('Summary copied'); } catch { flash('Copy blocked — select the text instead'); }
  },

  // setup / demo
  async loadSample() {
    const s = sampleData();
    await store.saveMany(s);
    await refresh();
    selectTrip(s.trips[0].id);
    state.screen = 'balances';
    render();
  },

  // your details
  async meFromContacts() {
    const c = await chooseContact();
    if (!c) return;
    state.meForm = { name: c.name || state.meForm.name, phone: c.phone || state.meForm.phone };
    render();
  },
  claimParty(d) {
    const p = partyById(d.id);
    if (!p) return;
    state.meForm = { name: p.name, phone: p.phone || state.meForm?.phone || '' };
    state.claimId = p.id;
    render();
  },
  async saveMe() {
    const f = state.meForm;
    const name = f.name.trim();
    if (!name) { flash('Enter your name.'); return; }
    const existing = partyById(myPartyId()) || (state.claimId ? partyById(state.claimId) : null);
    const p = existing
      ? { ...existing, name, phone: f.phone.trim(), email: myEmail() }
      : { id: uuid(), name, phone: f.phone.trim(), email: myEmail(), color: state.data.parties.length % PALETTE.length, createdAt: new Date().toISOString() };
    pref.set('askedDetails:' + store.groupId, '1');
    const before = snapshot();
    state.claimId = null;
    await commit(() => { replaceIn('parties', p); state.screen = curTrip() ? 'balances' : 'trips'; state.form = blankForm(); },
      () => store.saveParty(p), () => { state.data = before; }, `Thanks, ${name.split(' ')[0]}`);
  },
  async skipMe() {
    pref.set('askedDetails:' + store.groupId, '1');
    state.claimId = null;
    if (!myPartyId()) {
      // Still add you, named from your email, so expenses can include you. Edit it later under People.
      const guess = myEmail().split('@')[0].replace(/[._-]+/g, ' ').replace(/\d+/g, '').trim();
      state.meForm = { name: guess ? guess.replace(/\b\w/g, (c) => c.toUpperCase()) : 'Me', phone: '' };
      await actions.saveMe();
      return;
    }
    state.screen = curTrip() ? 'balances' : 'trips';
    render();
  },

  // sign-in
  async sendCode() {
    const email = state.authEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { state.authMsg = 'Enter a valid email address.'; render(); return; }
    state.authEmail = email;
    state.authBusy = true; state.authMsg = ''; render();
    try {
      await store.auth.sendCode(email);
      state.auth = 'codeSent'; state.authCode = ''; state.authMsg = '';
    } catch (err) {
      state.authMsg = /rate|limit|seconds/i.test(err?.message || '') ? 'Too many codes requested. Wait a minute and try again.' : 'Couldn’t send the code. ' + (err?.message || '');
    }
    state.authBusy = false; render();
  },
  async verifyCode() {
    const code = state.authCode.replace(/\s/g, '');
    if (!/^\d{6,10}$/.test(code)) { state.authMsg = 'Enter the code from the email.'; render(); return; }
    state.authBusy = true; state.authMsg = ''; render();
    try {
      state.user = await store.auth.verifyCode(state.authEmail, code);
      state.authBusy = false;
      await enterGroup();
    } catch (err) {
      state.authBusy = false;
      state.authMsg = /expired|invalid/i.test(err?.message || '') ? 'That code is wrong or expired. Check it, or send a new one.' : 'Couldn’t sign in. ' + (err?.message || '');
      render();
    }
  },
  changeEmail() { state.auth = 'signedOut'; state.authCode = ''; state.authMsg = ''; render(); },
  async checkGroups() { state.authMsg = ''; await enterGroup(); if (state.auth === 'noGroup') { state.authMsg = 'Not added yet.'; render(); } },
  async createGroup() {
    state.authBusy = true; state.authMsg = ''; render();
    try {
      const id = await store.createGroup(state.groupName.trim() || 'Our trips');
      pref.set('activeGroup', id);
      await enterGroup();
    } catch (err) {
      state.authBusy = false; state.authMsg = 'Couldn’t create the group. ' + (err?.message || ''); render();
    }
  },
  async signOut() {
    if (!window.confirm('Sign out of Trip Split on this device?')) return;
    await store.auth.signOut();
    Object.assign(state, { auth: 'signedOut', user: null, groups: [], members: [], data: { trips: [], parties: [], entries: [] }, tripId: '', screen: 'balances', authCode: '', authMsg: '' });
    render();
  },
  async switchGroup(d) { pref.set('activeGroup', d.id); state.screen = 'trips'; await enterGroup(); },
  async addMember() {
    const email = state.newMember.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { flash('Enter a valid email address.'); return; }
    if (isMember(email)) { flash('They already have access.'); return; }
    await actions.grantAccess({ email });
    state.newMember = '';
    render();
  },
  async grantAccess(d) {
    const email = d.email.trim().toLowerCase();
    try {
      await store.addMember(email);
      state.members = state.members.concat([{ email, role: 'member', added_at: new Date().toISOString() }]);
      flash(`${email} can now sign in. Tap Invite to send them the link.`);
    } catch (err) { flash('Couldn’t add them. ' + (err?.message || '')); }
  },
  async removeMember(d) {
    const me = (state.user?.email || '').toLowerCase();
    const leaving = d.email === me;
    if (!window.confirm(leaving ? 'Leave this group? You’ll lose access to its trips.' : `Remove ${d.email}? They won’t be able to see these trips any more.`)) return;
    try {
      await store.removeMember(d.email);
      if (leaving) { pref.set('activeGroup', ''); await enterGroup(); return; }
      state.members = state.members.filter((m) => m.email !== d.email);
      flash(`${d.email} removed`);
    } catch (err) { flash('Couldn’t remove them. ' + (err?.message || '')); }
  },
};

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
  const rc = data && typeof data.currency === 'string' ? data.currency.toUpperCase() : '';
  if (rc && ALL_CURRENCIES.includes(rc) && rc !== (state.form.cur || CUR)) {
    patch.cur = rc; patch.rateManual = false; patch.rateFor = ''; patch.rate = '';
    note += ` Currency set to ${rc}.`;
  } else if (rc && !ALL_CURRENCIES.includes(rc)) note += ` Receipt is in ${rc}, which can’t be converted automatically.`;
  if (!ref) note += ' The photo couldn’t be saved.';
  Object.assign(state.form, patch);
  state.receipt = { ...state.receipt, status: 'done', ref, note };
  render();
}

// ---------- sample data (local demo only) ----------
function sampleData() {
  const now = new Date().toISOString();
  const y = new Date().getFullYear();
  const person = (name, color, phone = '') => ({ id: uuid(), name, phone, email: '', color, createdAt: now });
  const [E, M, J, S] = [person('Eric', 0), person('Maya', 1), person('Jon', 2), person('Sam', 3)];
  const lisbon = { id: uuid(), name: 'Lisbon (sample)', currency: '€', start: `${y}-10-10`, end: `${y}-10-17`, members: [E.id, M.id, J.id], createdAt: now };
  const ski = { id: uuid(), name: 'Ski weekend (sample)', currency: '$', start: `${y}-02-06`, end: `${y}-02-08`, members: [E.id, S.id], createdAt: now };
  const x = (trip, o) => ({ id: uuid(), tripId: trip.id, createdAt: now, shares: {}, receipt: '', ...o });
  const eq3 = (c) => ({ [E.id]: c, [M.id]: c, [J.id]: c });
  return {
    parties: [E, M, J, S],
    trips: [lisbon, ski],
    entries: [
      x(lisbon, { kind: 'expense', desc: 'Apartment, 7 nights', cat: 'Lodging', date: `${y}-10-10`, amount: 186000, payer: E.id, mode: 'equal', shares: eq3(62000) }),
      x(lisbon, { kind: 'expense', desc: 'Rental car', cat: 'Transport', date: `${y}-10-10`, amount: 41250, payer: M.id, mode: 'equal', shares: eq3(13750) }),
      x(lisbon, { kind: 'expense', desc: 'Market groceries', cat: 'Groceries', date: `${y}-10-11`, amount: 9630, payer: J.id, mode: 'equal', shares: eq3(3210) }),
      x(lisbon, { kind: 'expense', desc: 'Dinner out', cat: 'Food', date: `${y}-10-12`, amount: 14800, payer: M.id, mode: 'equal', shares: { [M.id]: 7400, [J.id]: 7400 } }),
      x(lisbon, { kind: 'expense', desc: 'Show tickets', cat: 'Activities', date: `${y}-10-13`, amount: 9000, payer: J.id, mode: 'equal', shares: { [E.id]: 4500, [J.id]: 4500 } }),
      x(lisbon, { kind: 'expense', desc: 'Surf lessons', cat: 'Activities', date: `${y}-10-14`, amount: 21000, payer: J.id, mode: 'exact', shares: { [M.id]: 14000, [J.id]: 7000 } }),
      x(lisbon, { kind: 'payment', from: J.id, to: E.id, amount: 20000, date: `${y}-10-15` }),
      x(ski, { kind: 'expense', desc: 'Cabin', cat: 'Lodging', date: `${y}-02-06`, amount: 64000, payer: S.id, mode: 'equal', shares: { [E.id]: 32000, [S.id]: 32000 } }),
      x(ski, { kind: 'expense', desc: 'Lift tickets', cat: 'Activities', date: `${y}-02-07`, amount: 31800, payer: E.id, mode: 'equal', shares: { [E.id]: 15900, [S.id]: 15900 } }),
    ],
  };
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
  const ds = el.dataset || {};
  if (ds.field) {
    if (ds.field === 'custom') state.form.custom[ds.id] = el.value;
    else state.form[ds.field] = el.value;
    if (ds.field === 'rate') { state.form.rateManual = true; const n = $('#fx-note'); if (n) n.textContent = fxNote(); }
    if (ds.field === 'date') ensureRate();
    updateAddLive();
  } else if (ds.np) state.newPerson[ds.np] = el.value;
  else if (ds.auth) state[ds.auth] = el.value;
  else if (ds.nm) state.newMember = el.value;
  else if (ds.tf && state.tripForm) state.tripForm[ds.tf] = el.value;
  else if (ds.pf && state.personForm) state.personForm[ds.pf] = el.value;
  else if (ds.mf && state.meForm) state.meForm[ds.mf] = el.value;
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && state.viewUrl) { state.viewUrl = ''; render(); }
  const ds = ev.target.dataset || {};
  if (ev.key === 'Enter' && ds.np) { ev.preventDefault(); actions.createPerson(); }
  if (ev.key === 'Enter' && ds.nm) { ev.preventDefault(); actions.addMember(); }
  if (ev.key === 'Enter' && ds.auth && !state.authBusy) {
    ev.preventDefault();
    if (ds.auth === 'authEmail') actions.sendCode();
    else if (ds.auth === 'authCode') actions.verifyCode();
    else if (ds.auth === 'groupName') actions.createGroup();
  }
});
document.addEventListener('change', (ev) => {
  if (ev.target.id === 'receipt-input') {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    handleReceipt(file);
    return;
  }
  const act = ev.target.dataset && ev.target.dataset.actionChange;
  if (act && actions[act]) actions[act]({ value: ev.target.value });
});

// Default the payer to whoever paid last on this trip (or the first person).
const _blankForm = blankForm;
function formWithDefaults() {
  const f = _blankForm();
  const ids = formIds();
  const last = pref.get('lastPayer:' + state.tripId);
  const me = myPartyId();
  f.payer = me || (ids.includes(last) ? last : ids[0] || '');
  return f;
}
const origGo = actions.go;
actions.go = (d) => {
  if (d.screen === 'add' && !state.editId && !state.form.amt && !state.form.desc) state.form = formWithDefaults();
  origGo(d);
};

// ---------- boot ----------
async function boot() {
  render();
  try {
    store = await createStore(CONFIG);
  } catch (err) {
    document.querySelector('#app').innerHTML = `<main id="main" class="setup"><h1>Trip Split</h1><p>Couldn’t reach the database. Check your connection and reload.</p><p class="small muted">${esc(err?.message || '')}</p></main>`;
    return;
  }
  if (store.mode === 'cloud') {
    state.user = await store.auth.user().catch(() => null);
    if (!state.user) { state.auth = 'signedOut'; render(); return; }
    await enterGroup();
    return;
  }
  state.auth = 'ready';
  state.tripId = pref.get('activeTrip:local');
  render();
  await refresh();
  if (!curTrip()) state.screen = 'trips';
  render();
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => {}); });
}
boot();
