// Stand-in for supabase-js used only by the browser test. Data lives in memory (window.__db),
// and it applies the same "who may change what" rules as the real database, so the app's
// buttons and error handling can be checked without reaching Supabase.
const db = window.__db;
const me = () => window.__me;
const role = (g) => (db.group_members.find((m) => m.group_id === g && m.email === me()) || {}).role;
const isMember = (g) => !!role(g);
const isAdmin = (g) => role(g) === 'admin';
const canChange = (r) => isAdmin(r.group_id) || (isMember(r.group_id) && (r.created_by_email || '') === me());
const denied = () => ({ data: null, error: { code: '42501', message: 'new row violates row-level security policy' } });
window.__calls = [];

const readable = {
  groups: (r) => isMember(r.id),
  group_members: (r) => isAdmin(r.group_id) || r.email === me(),
  invitations: (r) => isAdmin(r.group_id),
  parties: (r) => isMember(r.group_id), trips: (r) => isMember(r.group_id),
  entries: (r) => isMember(r.group_id), categories: (r) => isMember(r.group_id),
};
const owned = ['trips', 'entries', 'categories'];
const activeTrip = (id) => db.trips.some((x) => x.id === id && !x.inactive_at);
function mayWrite(t, existing, row, op) {
  if (owned.includes(t)) {
    if (t === 'entries' && !activeTrip(row.trip_id || (existing && existing.trip_id))) return false;
    if (op === 'insert') return isMember(row.group_id);
    if (!canChange(existing)) return false;
    if (t === 'trips' && op === 'delete')
      return db.entries.every((e) => e.trip_id !== existing.id || e.created_by_email === me());
    return true;
  }
  if (t === 'parties') return isAdmin(row.group_id) || (isMember(row.group_id) && (row.email || '') === me() && (!existing || (existing.email || '') === me()));
  return isAdmin(row.group_id || row.id);
}

class Q {
  constructor(t) { this.t = t; this.op = 'select'; this.f = []; this.one = false; }
  select() { return this; }
  eq(k, v) { this.f.push((r) => r[k] === v); return this; }
  is(k, v) { this.f.push((r) => (r[k] ?? null) === v); return this; }
  order() { return this; }
  single() { this.one = true; return this; }
  insert(rows) { this.op = 'insert'; this.rows = [].concat(rows); return this; }
  upsert(rows) { this.op = 'upsert'; this.rows = [].concat(rows); return this; }
  update(v) { this.op = 'update'; this.vals = v; return this; }
  delete() { this.op = 'delete'; return this; }
  then(ok, bad) { return Promise.resolve().then(() => this.run()).then(ok, bad); }
  run() {
    const t = this.t, all = db[t];
    window.__calls.push(`${this.op} ${t}`);
    const match = () => all.filter((r) => readable[t](r) && this.f.every((f) => f(r)));
    if (this.op === 'select') { const d = match(); return { data: this.one ? d[0] : d, error: null }; }
    if (this.op === 'delete') {
      const gone = match().filter((r) => mayWrite(t, r, r, 'delete'));
      db[t] = all.filter((r) => !gone.includes(r));
      if (t === 'trips') db.entries = db.entries.filter((e) => !gone.some((g) => g.id === e.trip_id));
      return { data: gone, error: null };
    }
    if (this.op === 'update') {
      const hit = match().filter((r) => mayWrite(t, r, { ...r, ...this.vals }, 'update'));
      hit.forEach((r) => { Object.assign(r, this.vals); if (t === 'trips' && 'inactive_at' in this.vals) r.inactive_by = this.vals.inactive_at ? me() : null; });
      return { data: hit, error: null };
    }
    const out = [];
    for (const row of this.rows) {
      const key = t === 'invitations' ? 'token' : 'id';
      const existing = row[key] && all.find((r) => r[key] === row[key]);
      if (existing && this.op === 'upsert') {
        if (!mayWrite(t, existing, { ...existing, ...row }, 'update')) return denied();
        const oldName = existing.name;
        Object.assign(existing, row, owned.includes(t) ? { created_by_email: existing.created_by_email } : {});
        if (t === 'categories' && oldName !== existing.name)
          db.entries.forEach((e) => { if (e.group_id === existing.group_id && e.category === oldName) e.category = existing.name; });
        out.push(existing);
      } else {
        if (!mayWrite(t, null, row, 'insert')) return denied();
        const r = { ...row, ...(owned.includes(t) ? { created_by_email: me() } : {}) };
        if (t === 'invitations') Object.assign(r, { token: crypto.randomUUID(), expires_at: '2026-12-21', accepted_at: null });
        all.push(r); out.push(r);
      }
    }
    return { data: this.one ? out[0] : out, error: null };
  }
}

export function createClient() {
  return {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: 'u-' + me(), email: me() } } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({ error: null }),
    },
    from: (t) => new Q(t),
    async rpc(name, args) {
      window.__calls.push('rpc ' + name);
      if (name === 'can_create_group') return { data: db.group_members.some((m) => m.email === me()), error: null };
      if (name === 'create_group') {
        if (!db.group_members.some((m) => m.email === me())) return { data: null, error: { code: '42501', message: 'Creating groups is limited to Administrators.' } };
        const gid = crypto.randomUUID();
        db.groups.push({ id: gid, name: args.group_name, created_at: new Date().toISOString() });
        db.group_members.push({ group_id: gid, email: me(), role: 'admin', added_at: new Date().toISOString() });
        ['Lodging', 'Food', 'Other'].forEach((n, i) => db.categories.push({ id: crypto.randomUUID(), group_id: gid, name: n, sort: (i + 1) * 10, created_by_email: me() }));
        return { data: gid, error: null };
      }
      if (name === 'delete_trip') {
        const t = db.trips.find((x) => x.id === args.trip);
        if (!t) return { data: null, error: { code: 'P0002', message: 'trip_not_found' } };
        if (!canChange(t)) return denied();
        const mine = (e) => (e.created_by_email || t.created_by_email) === me();
        const who = [...new Set(db.entries.filter((e) => e.trip_id === t.id && !mine(e)).map((e) => e.created_by_email))].sort();
        const meName = (db.parties.find((p) => p.group_id === t.group_id && p.email === me()) || {}).name || me();
        const origin = `${t.name} · deleted by ${meName} · ${new Date().toISOString().slice(0, 10)}`;
        const moved = [];
        for (const email of who) {
          const p = db.parties.find((x) => x.group_id === t.group_id && x.email === email);
          const person = p ? p.name.split(' ')[0] : email.split('@')[0];
          let d = db.trips.find((x) => x.group_id === t.group_id && x.default_for_email === email && x.currency === t.currency && x.id !== t.id);
          if (!d) {
            d = { id: crypto.randomUUID(), group_id: t.group_id, name: `${person}'s expenses`, currency: t.currency, currencies: [t.currency], member_ids: p ? [p.id] : [], weights: {}, default_split: 'equal', created_by_email: email, default_for_email: email, inactive_at: null, created_at: new Date().toISOString() };
            db.trips.push(d);
          } else d.inactive_at = null;
          const es = db.entries.filter((e) => e.trip_id === t.id && e.created_by_email === email);
          es.forEach((e) => { e.trip_id = d.id; e.moved_from = origin; });
          moved.push({ email, name: person, trip_id: d.id, trip_name: d.name, count: es.length });
        }
        const deleted = db.entries.filter((e) => e.trip_id === t.id).length;
        db.entries = db.entries.filter((e) => e.trip_id !== t.id);
        db.trips = db.trips.filter((x) => x.id !== t.id);
        return { data: { deleted, moved }, error: null };
      }
      if (name === 'add_to_trip') {
        const t = db.trips.find((x) => x.id === args.trip);
        if (!t || !isMember(t.group_id)) return denied();
        args.people.forEach((p) => { if (db.parties.some((x) => x.id === p && x.group_id === t.group_id) && !t.member_ids.includes(p)) t.member_ids.push(p); });
        args.add_currencies.forEach((c) => { if (/^[A-Z]{3}$/.test(c) && !t.currencies.includes(c)) t.currencies.push(c); });
        return { data: null, error: null };
      }
      return { data: null, error: null };
    },
    storage: { from: () => ({
      upload: async (path) => ({ data: { path }, error: null }),
      createSignedUrl: async () => ({ data: { signedUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=' }, error: null }),
      list: async () => ({ data: [], error: null }), remove: async () => ({ data: [], error: null }),
    }) },
    functions: { invoke: async (n) => ({ data: n === 'fx-rate' ? { rate: 1.1, date: '2026-11-21' } : null, error: null }) },
  };
}
