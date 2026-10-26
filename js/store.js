// Two backends with the same interface:
//   mode, list(), add(entry), remove(id), uploadReceipt(blob) -> ref, receiptUrl(ref), extract(blob) -> data|null
// local: this browser only (localStorage). cloud: Supabase table + storage + edge function.

const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

export async function createStore(config, tripId) {
  if (config.supabaseUrl && config.supabaseAnonKey && tripId) {
    return cloudStore(config, tripId);
  }
  return localStore(tripId || 'local');
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// ---------- local ----------
function localStore(tripId) {
  const key = 'tripsplit:entries:' + tripId;
  const read = () => {
    try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; }
  };
  const write = (list) => {
    try { localStorage.setItem(key, JSON.stringify(list)); }
    catch { throw new Error('storage_full'); }
  };
  return {
    mode: 'local',
    async list() { return read(); },
    async add(entry) { write(read().concat([entry])); },
    async addMany(entries) { write(read().concat(entries)); },
    async remove(id) { write(read().filter((e) => e.id !== id)); },
    async clear() { try { localStorage.removeItem(key); } catch {} },
    // Local mode keeps a small JPEG inline (localStorage holds roughly 5 MB).
    async uploadReceipt(blob) { return blobToDataURL(blob); },
    receiptUrl(ref) { return ref || ''; },
    async extract() { return null; },
  };
}

// ---------- cloud (Supabase) ----------
async function cloudStore(config, tripId) {
  const { createClient } = await import(SUPABASE_JS);
  // The trip id travels as a header; row-level security only returns rows for that trip.
  const sb = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: false },
    global: { headers: { 'x-trip-id': tripId } },
  });

  const toRow = (e) => ({
    id: e.id,
    trip_id: tripId,
    kind: e.kind,
    description: e.desc ?? null,
    category: e.cat ?? null,
    spent_on: e.date,
    amount_cents: e.amount,
    payer: e.payer ?? null,
    shares: e.shares ?? {},
    split_mode: e.mode ?? null,
    from_party: e.from ?? null,
    to_party: e.to ?? null,
    receipt_path: e.receipt || null,
    created_at: e.createdAt,
  });
  const fromRow = (r) => ({
    id: r.id,
    kind: r.kind,
    desc: r.description ?? '',
    cat: r.category ?? 'Other',
    date: r.spent_on,
    amount: r.amount_cents,
    payer: r.payer,
    shares: r.shares || {},
    mode: r.split_mode,
    from: r.from_party,
    to: r.to_party,
    receipt: r.receipt_path || '',
    createdAt: r.created_at,
  });

  return {
    mode: 'cloud',
    async list() {
      const { data, error } = await sb.from('entries').select('*').eq('trip_id', tripId).order('created_at');
      if (error) throw error;
      return (data || []).map(fromRow);
    },
    async add(entry) {
      const { error } = await sb.from('entries').insert(toRow(entry));
      if (error) throw error;
    },
    async addMany(entries) {
      const { error } = await sb.from('entries').insert(entries.map(toRow));
      if (error) throw error;
    },
    async remove(id) {
      const { error } = await sb.from('entries').delete().eq('id', id);
      if (error) throw error;
    },
    async clear() {},
    async uploadReceipt(blob) {
      const path = tripId + '/' + crypto.randomUUID() + '.jpg';
      const { error } = await sb.storage.from('receipts').upload(path, blob, { contentType: blob.type || 'image/jpeg' });
      if (error) throw error;
      return path;
    },
    receiptUrl(ref) {
      if (!ref) return '';
      if (ref.startsWith('data:')) return ref;
      return sb.storage.from('receipts').getPublicUrl(ref).data.publicUrl;
    },
    async extract(blob) {
      const dataUrl = await blobToDataURL(blob);
      const image = dataUrl.slice(dataUrl.indexOf(',') + 1);
      const { data, error } = await sb.functions.invoke('extract-receipt', {
        body: { image, mediaType: blob.type || 'image/jpeg', year: new Date().getFullYear() },
      });
      if (error) throw error;
      return data && !data.error ? data : null;
    },
  };
}
