// Ledger export: builds the tables once, then writes them to a new Google Sheet in the
// signed-in person's own Google account, or to a CSV file.

const GSI_SRC = 'https://accounts.google.com/gsi/client';
// drive.file = only files this app creates. It can't read the rest of your Drive.
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

// ---------- tables ----------
// ctx: { trip, entries (sorted), ids, nameOf, calc, transfers, cur, addedBy }
export function buildTables(ctx) {
  const { trip, entries, ids, nameOf, calc, transfers, cur, addedBy } = ctx;
  const n = (c) => (c == null ? '' : Math.round(c) / 100);
  const people = ids.map(nameOf);

  const ledgerHead = ['Date', 'Description', 'Category', 'Type', 'Paid by', 'Amount spent', 'Currency spent', 'Rate', `Amount (${cur})`, 'Shared by',
    ...people.map((p) => `${p} share (${cur})`), 'Added by', 'Receipt'];
  const ledgerRows = entries.map((e) => {
    const isPay = e.kind === 'payment';
    const sharers = isPay ? [] : Object.keys(e.shares || {}).filter((id) => e.shares[id] > 0);
    const foreign = !!(e.origCurrency && e.origCurrency !== cur && e.origAmount != null);
    return [
      e.date || '',
      isPay ? `Payment to ${nameOf(e.to)}` : e.desc,
      isPay ? '' : e.cat,
      isPay ? 'Settle-up payment' : 'Expense',
      nameOf(isPay ? e.from : e.payer),
      n(foreign ? e.origAmount : e.amount),
      foreign ? e.origCurrency : cur,
      foreign ? Number(e.fxRate) : 1,
      n(e.amount),
      isPay ? nameOf(e.to) : sharers.map(nameOf).join(', '),
      ...ids.map((id) => (isPay ? '' : (e.shares[id] ? n(e.shares[id]) : ''))),
      e.createdBy ? addedBy(e.createdBy) : '',
      e.receipt ? 'Yes' : '',
    ];
  });

  const balancesHead = ['Person', `Spent (${cur})`, `Benefitted (${cur})`, `Payments sent (${cur})`, `Payments received (${cur})`, `Net (${cur})`, 'Position'];
  const balancesRows = ids.map((id) => {
    const b = calc.b[id];
    const net = calc.net[id];
    return [nameOf(id), n(b.paid), n(b.share), n(b.sent), n(b.recv), n(net), net > 0 ? 'Is owed' : net < 0 ? 'Owes' : 'Square'];
  });
  balancesRows.push(['Total', n(calc.total), n(calc.total), '', '', '', '']);

  const settleHead = ['From', 'To', `Amount (${cur})`];
  const settleRows = transfers.length ? transfers.map((t) => [nameOf(t.from), nameOf(t.to), n(t.amount)]) : [['Everyone is square', '', '']];

  return {
    title: `${trip.name} — Trip Split ledger (${new Date().toISOString().slice(0, 10)})`,
    tables: [
      { title: 'Ledger', rows: [ledgerHead, ...ledgerRows] },
      { title: 'Balances', rows: [balancesHead, ...balancesRows] },
      { title: 'Settle up', rows: [settleHead, ...settleRows] },
    ],
  };
}

// ---------- CSV ----------
export function toCsv(rows) {
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\r\n');
}

export function downloadCsv(filename, rows) {
  const blob = new Blob(['﻿' + toCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---------- Google ----------
let gsiPromise = null;
// Load Google's sign-in library ahead of time, so the permission popup opens straight from the tap.
export function preloadGoogle() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (!gsiPromise) {
    gsiPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = GSI_SRC;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { gsiPromise = null; reject(new Error('Couldn’t load Google sign-in.')); };
      document.head.appendChild(s);
    });
  }
  return gsiPromise;
}

let token = null; // { value, expires }
function getToken(clientId, loginHint) {
  if (token && Date.now() < token.expires - 60000) return Promise.resolve(token.value);
  return new Promise((resolve, reject) => {
    if (!window.google?.accounts?.oauth2) { reject(new Error('Google sign-in isn’t ready yet. Try again in a moment.')); return; }
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      login_hint: loginHint || undefined,
      callback: (r) => {
        if (r && r.access_token) {
          token = { value: r.access_token, expires: Date.now() + (Number(r.expires_in) || 3600) * 1000 };
          resolve(token.value);
        } else reject(new Error(r?.error_description || r?.error || 'Google didn’t grant access.'));
      },
      error_callback: (e) => reject(new Error(e?.type === 'popup_closed' ? 'cancelled' : (e?.message || 'Google sign-in failed.'))),
    });
    client.requestAccessToken({ prompt: '' });
  });
}

async function api(tokenValue, url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + tokenValue, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401) token = null;
    throw new Error(data?.error?.message || `Google Sheets error ${r.status}`);
  }
  return data;
}

// Creates the spreadsheet, fills every tab, bolds and freezes header rows. -> spreadsheet URL
export async function exportToGoogle({ clientId, loginHint, title, tables }) {
  const t = await getToken(clientId, loginHint);
  const sheet = await api(t, 'https://sheets.googleapis.com/v4/spreadsheets', {
    properties: { title },
    sheets: tables.map((tb, i) => ({ properties: { sheetId: i, title: tb.title, gridProperties: { frozenRowCount: 1 } } })),
  });
  const id = sheet.spreadsheetId;
  await api(t, `https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchUpdate`, {
    valueInputOption: 'RAW',
    data: tables.map((tb) => ({ range: `'${tb.title.replace(/'/g, "''")}'!A1`, values: tb.rows })),
  });
  await api(t, `https://sheets.googleapis.com/v4/spreadsheets/${id}:batchUpdate`, {
    requests: tables.flatMap((tb, i) => [
      { repeatCell: { range: { sheetId: i, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } },
      { autoResizeDimensions: { dimensions: { sheetId: i, dimension: 'COLUMNS', startIndex: 0, endIndex: tb.rows[0].length } } },
    ]),
  });
  return sheet.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${id}/edit`;
}
