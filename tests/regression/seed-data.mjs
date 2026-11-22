// One fixture dataset for both modes. The hermetic fixture loads it into the stand-in
// (window.__db); seed.mjs (step 5 of the plan) writes the same rows to the staging database.
// Every amount here is hand-checked: see the expected numbers in EXPECT below.

export const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// Groups
export const G = id(1);       // "Regression": Ada (Administrator), Uma (User), Paul (no sign-in)
export const G_OTHER = id(2); // "Other group": Olly only, so he's an outsider to "Regression"

// People (parties)
export const P = { ada: id(11), uma: id(12), paul: id(13), olly: id(14) };

// Sign-ins
export const USERS = {
  admin: { email: 'ada@regression.test', group: G, party: P.ada, name: 'Ada Archer' },
  user: { email: 'uma@regression.test', group: G, party: P.uma, name: 'Uma Underwood' },
  outsider: { email: 'olly@regression.test', group: G_OTHER, party: P.olly, name: 'Olly Oakes' },
};

// Trips
export const TRIPS = { usd: id(21), eur: id(22), cabins: id(23), inactive: id(24) };

const ADA = USERS.admin.email, UMA = USERS.user.email;

export const seed = () => ({
  groups: [
    { id: G, name: 'Regression', created_at: '2026-10-01T00:00:00Z' },
    { id: G_OTHER, name: 'Other group', created_at: '2026-10-01T00:00:00Z' },
  ],
  group_members: [
    { group_id: G, email: ADA, role: 'admin', added_at: '2026-10-01' },
    { group_id: G, email: UMA, role: 'user', added_at: '2026-10-02' },
    { group_id: G_OTHER, email: USERS.outsider.email, role: 'admin', added_at: '2026-10-01' },
  ],
  invitations: [],
  parties: [
    { id: P.ada, group_id: G, name: 'Ada Archer', email: ADA, color: 0, payment: { venmo: 'ada-archer', preferred: 'venmo' }, created_at: '2026-10-01' },
    { id: P.uma, group_id: G, name: 'Uma Underwood', email: UMA, color: 1, payment: {}, created_at: '2026-10-01' },
    { id: P.paul, group_id: G, name: 'Paul Porter', email: null, color: 2, payment: {}, created_at: '2026-10-01' },
    { id: P.olly, group_id: G_OTHER, name: 'Olly Oakes', email: USERS.outsider.email, color: 3, payment: {}, created_at: '2026-10-01' },
  ],
  trips: [
    { id: TRIPS.usd, group_id: G, name: 'Regression USD', currency: 'USD', currencies: ['USD', 'EUR'], member_ids: [P.ada, P.uma, P.paul],
      weights: {}, default_split: 'equal', start_on: '2026-10-14', end_on: '2026-10-20', created_by_email: ADA,
      created_at: '2026-10-04T00:00:00Z', inactive_at: null, default_for_email: null },
    { id: TRIPS.eur, group_id: G, name: 'Regression EUR', currency: 'EUR', currencies: ['EUR', 'USD'], member_ids: [P.ada, P.uma],
      weights: {}, default_split: 'equal', start_on: '2026-09-01', end_on: '2026-09-07', created_by_email: ADA,
      created_at: '2026-10-03T00:00:00Z', inactive_at: null, default_for_email: null },
    // Three families sharing a boat: people 4:3:3, cabins 2:1:1.
    { id: TRIPS.cabins, group_id: G, name: 'Regression boat', currency: 'USD', currencies: ['USD', 'EUR'], member_ids: [P.ada, P.uma, P.paul],
      weights: { people: { [P.ada]: 4, [P.uma]: 3, [P.paul]: 3 }, cabins: { [P.ada]: 2, [P.uma]: 1, [P.paul]: 1 } }, default_split: 'people',
      start_on: '2026-08-01', end_on: '2026-08-08', created_by_email: ADA, created_at: '2026-10-02T00:00:00Z', inactive_at: null, default_for_email: null },
    { id: TRIPS.inactive, group_id: G, name: 'Regression old trip', currency: 'USD', currencies: ['USD'], member_ids: [P.ada, P.uma],
      weights: {}, default_split: 'equal', start_on: '2026-05-01', end_on: '2026-05-03', created_by_email: ADA,
      created_at: '2026-10-01T00:00:00Z', inactive_at: '2026-06-01T00:00:00Z', inactive_by: ADA, default_for_email: null },
  ],
  entries: [
    // Regression USD
    { id: id(31), group_id: G, trip_id: TRIPS.usd, kind: 'expense', description: 'Harbor dinner', category: 'Food', spent_on: '2026-10-15',
      amount_cents: 9000, payer: P.ada, shares: { [P.ada]: 3000, [P.uma]: 3000, [P.paul]: 3000 }, split_mode: 'equal',
      created_by_email: ADA, created_at: '2026-10-15T19:00:00Z' },
    { id: id(32), group_id: G, trip_id: TRIPS.usd, kind: 'expense', description: 'Airport taxi', category: 'Transport', spent_on: '2026-10-16',
      amount_cents: 4500, payer: P.uma, shares: { [P.ada]: 2250, [P.uma]: 2250 }, split_mode: 'equal',
      created_by_email: UMA, created_at: '2026-10-16T08:00:00Z' },
    { id: id(33), group_id: G, trip_id: TRIPS.usd, kind: 'expense', description: 'Groceries', category: 'Food', spent_on: '2026-10-16',
      amount_cents: 10000, payer: P.paul, shares: { [P.ada]: 3334, [P.uma]: 3333, [P.paul]: 3333 }, split_mode: 'equal',
      created_by_email: ADA, created_at: '2026-10-16T12:00:00Z' },
    // Regression EUR
    { id: id(34), group_id: G, trip_id: TRIPS.eur, kind: 'expense', description: 'Museum tickets', category: 'Activities', spent_on: '2026-09-02',
      amount_cents: 5000, payer: P.ada, shares: { [P.ada]: 2500, [P.uma]: 2500 }, split_mode: 'equal',
      created_by_email: ADA, created_at: '2026-09-02T10:00:00Z' },
    // Regression old trip (inactive)
    { id: id(35), group_id: G, trip_id: TRIPS.inactive, kind: 'expense', description: 'Old hotel', category: 'Lodging', spent_on: '2026-05-01',
      amount_cents: 20000, payer: P.uma, shares: { [P.ada]: 10000, [P.uma]: 10000 }, split_mode: 'equal',
      created_by_email: UMA, created_at: '2026-05-01T10:00:00Z' },
  ],
  categories: ['Food', 'Lodging', 'Transport', 'Activities', 'Other'].map((name, i) => (
    { id: id(41 + i), group_id: G, name, sort: (i + 1) * 10, created_by_email: ADA })),
});

// Hand-checked results for "Regression USD" (amounts in cents).
//   Ada  paid 9000,  share 3000 + 2250 + 3334 = 8584 → net  +416
//   Uma  paid 4500,  share 3000 + 2250 + 3333 = 8583 → net −4083
//   Paul paid 10000, share 3000 + 3333        = 6333 → net +3667
export const EXPECT = {
  usd: {
    total: 23500,
    count: 3,
    spent: { [P.ada]: 9000, [P.uma]: 4500, [P.paul]: 10000 },
    benefitted: { [P.ada]: 8584, [P.uma]: 8583, [P.paul]: 6333 },
    net: { [P.ada]: 416, [P.uma]: -4083, [P.paul]: 3667 },
  },
};
