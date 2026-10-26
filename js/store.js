// Two backends with the same data interface. All data belongs to one "group" (you and the
// people you travel with); a group holds many trips, a shared list of people, and the
// expenses of each trip.
//
//   mode
//   load()                     -> { trips, parties, entries }
//   saveTrip(t)  deleteTrip(id)        (deleting a trip deletes its expenses)
//   saveParty(p) deleteParty(id)
//   saveEntry(e) deleteEntry(id)
//   saveMany({ trips, parties, entries })
//   uploadReceipt(blob) -> ref   receiptUrl(ref) (sync, '' until signed)   signReceipt(ref)
//   extract(blob) -> data|null
//   clear()  (local only)
//
// Cloud only: auth.{user, sendCode, verifyCode, signOut}, listGroups, createGroup,
//   useGroup(id), groupId, members, addMember(email), removeMember(email)

const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

export async function createStore(config) {
  if (config.supabaseUrl && config.supabaseAnonKey) return cloudStore(config);
  return localStore('local');
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

const upsertById = (list, item) => {
  const i = list.findIndex((x) => x.id === item.id);
  if (i >= 0) { const copy = list.slice(); copy[i] = item; return copy; }
  return list.concat([item]);
};

// ---------- local (this browser only, no sign-in) ----------
function localStore(groupId) {
  const key = 'tripsplit:v2:' + groupId;
  const empty = () => ({ trips: [], parties: [], entries: [] });
  const read = () => {
    try { return { ...empty(), ...JSON.parse(localStorage.getItem(key) || '{}') }; } catch { return empty(); }
  };
  const write = (d) => {
    try { localStorage.setItem(key, JSON.stringify(d)); } catch { throw new Error('storage_full'); }
  };
  const update = (fn) => { const d = read(); fn(d); write(d); };
  return {
    mode: 'local',
    groupId,
    async load() { return read(); },
    async saveTrip(t) { update((d) => { d.trips = upsertById(d.trips, t); }); },
    async deleteTrip(id) { update((d) => { d.trips = d.trips.filter((t) => t.id !== id); d.entries = d.entries.filter((e) => e.tripId !== id); }); },
    async saveParty(p) { update((d) => { d.parties = upsertById(d.parties, p); }); },
    async deleteParty(id) { update((d) => { d.parties = d.parties.filter((p) => p.id !== id); }); },
    async saveEntry(e) { update((d) => { d.entries = upsertById(d.entries, e); }); },
    async deleteEntry(id) { update((d) => { d.entries = d.entries.filter((e) => e.id !== id); }); },
    async saveMany(more) {
      update((d) => {
        (more.parties || []).forEach((p) => { d.parties = upsertById(d.parties, p); });
        (more.trips || []).forEach((t) => { d.trips = upsertById(d.trips, t); });
        (more.entries || []).forEach((e) => { d.entries = upsertById(d.entries, e); });
      });
    },
    async clear() { try { localStorage.removeItem(key); } catch {} },
    // Local mode keeps a small JPEG inline (localStorage holds roughly 5 MB).
    async uploadReceipt(blob) { return blobToDataURL(blob); },
    receiptUrl(ref) { return ref || ''; },
    async signReceipt() {},
    async extract() { return null; },
  };
}

// ---------- cloud (Supabase, with email sign-in) ----------
async function cloudStore(config) {
  const { createClient } = await import(SUPABASE_JS);
  const sb = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'tripsplit-auth' },
  });
  const must = ({ data, error }) => { if (error) throw error; return data; };
  let groupId = '';
  const signed = new Map(); // receipt path -> { url, at }

  const tripRow = (t) => ({ id: t.id, group_id: groupId, name: t.name, currency: t.currency, start_on: t.start || null, end_on: t.end || null, member_ids: t.members || [], created_at: t.createdAt });
  const tripFrom = (r) => ({ id: r.id, name: r.name, currency: r.currency, start: r.start_on || '', end: r.end_on || '', members: r.member_ids || [], createdAt: r.created_at });
  const partyRow = (p) => ({ id: p.id, group_id: groupId, name: p.name, phone: p.phone || null, email: p.email || null, color: p.color ?? 0, created_at: p.createdAt });
  const partyFrom = (r) => ({ id: r.id, name: r.name, phone: r.phone || '', email: r.email || '', color: r.color ?? 0, createdAt: r.created_at });
  const entryRow = (e) => ({
    id: e.id, group_id: groupId, trip_id: e.tripId, kind: e.kind,
    description: e.desc ?? null, category: e.cat ?? null, spent_on: e.date, amount_cents: e.amount,
    payer: e.payer ?? null, shares: e.shares ?? {}, split_mode: e.mode ?? null,
    from_party: e.from ?? null, to_party: e.to ?? null, receipt_path: e.receipt || null, created_at: e.createdAt,
  });
  const entryFrom = (r) => ({
    id: r.id, tripId: r.trip_id, kind: r.kind, desc: r.description ?? '', cat: r.category ?? 'Other',
    date: r.spent_on, amount: r.amount_cents, payer: r.payer, shares: r.shares || {}, mode: r.split_mode,
    from: r.from_party, to: r.to_party, receipt: r.receipt_path || '', createdAt: r.created_at,
  });

  return {
    mode: 'cloud',
    get groupId() { return groupId; },
    useGroup(id) { groupId = id; signed.clear(); },

    auth: {
      async user() { const { data } = await sb.auth.getSession(); return data.session ? data.session.user : null; },
      async sendCode(email) { const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true } }); if (error) throw error; },
      async verifyCode(email, token) { const { data, error } = await sb.auth.verifyOtp({ email, token, type: 'email' }); if (error) throw error; return data.user; },
      async signOut() { await sb.auth.signOut(); },
    },

    async listGroups() { return must(await sb.from('groups').select('id, name, created_at').order('created_at')); },
    async createGroup(name) { return must(await sb.rpc('create_group', { group_name: name })); },
    async members() { return must(await sb.from('group_members').select('email, role, added_at').eq('group_id', groupId).order('added_at')); },
    async addMember(email) { must(await sb.from('group_members').insert({ group_id: groupId, email: email.trim().toLowerCase(), role: 'member' })); },
    async removeMember(email) { must(await sb.from('group_members').delete().eq('group_id', groupId).eq('email', email)); },

    async load() {
      const [trips, parties, entries] = await Promise.all([
        sb.from('trips').select('*').eq('group_id', groupId).then(must),
        sb.from('parties').select('*').eq('group_id', groupId).then(must),
        sb.from('entries').select('*').eq('group_id', groupId).order('created_at').then(must),
      ]);
      return { trips: trips.map(tripFrom), parties: parties.map(partyFrom), entries: entries.map(entryFrom) };
    },
    async saveTrip(t) { must(await sb.from('trips').upsert(tripRow(t))); },
    async deleteTrip(id) { must(await sb.from('trips').delete().eq('id', id)); },
    async saveParty(p) { must(await sb.from('parties').upsert(partyRow(p))); },
    async deleteParty(id) { must(await sb.from('parties').delete().eq('id', id)); },
    async saveEntry(e) { must(await sb.from('entries').upsert(entryRow(e))); },
    async deleteEntry(id) { must(await sb.from('entries').delete().eq('id', id)); },
    async saveMany(more) {
      if (more.parties?.length) must(await sb.from('parties').upsert(more.parties.map(partyRow)));
      if (more.trips?.length) must(await sb.from('trips').upsert(more.trips.map(tripRow)));
      if (more.entries?.length) must(await sb.from('entries').upsert(more.entries.map(entryRow)));
    },
    async clear() {},

    // Receipts live in a private bucket under <group id>/; viewing needs a short-lived signed link.
    async uploadReceipt(blob) {
      const path = groupId + '/' + crypto.randomUUID() + '.jpg';
      must(await sb.storage.from('receipts').upload(path, blob, { contentType: blob.type || 'image/jpeg' }));
      return path;
    },
    receiptUrl(ref) {
      if (!ref) return '';
      if (ref.startsWith('data:')) return ref;
      const s = signed.get(ref);
      return s && Date.now() - s.at < 50 * 60 * 1000 ? s.url : '';
    },
    async signReceipt(ref) {
      if (!ref || ref.startsWith('data:')) return;
      const { data, error } = await sb.storage.from('receipts').createSignedUrl(ref, 3600);
      if (error) throw error;
      signed.set(ref, { url: data.signedUrl, at: Date.now() });
    },
    async extract(blob) {
      const dataUrl = await blobToDataURL(blob);
      const image = dataUrl.slice(dataUrl.indexOf(',') + 1);
      const { data, error } = await sb.functions.invoke('extract-receipt', {
        headers: { 'x-group-id': groupId },
        body: { image, mediaType: blob.type || 'image/jpeg', year: new Date().getFullYear() },
      });
      if (error) throw error;
      return data && !data.error ? data : null;
    },
  };
}
