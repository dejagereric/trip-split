// Edit this file before deploying. Everything here is public once on GitHub Pages.
export const CONFIG = {
  tripName: 'Our trip',
  currency: '$',

  // Exactly three parties. Ids are short, permanent keys; names can change any time.
  parties: [
    { id: 'A', name: 'Eric' },
    { id: 'B', name: 'Party 2' },
    { id: 'C', name: 'Party 3' },
  ],

  // Leave both blank for local demo mode (data stays on one phone, no receipt reading).
  // Fill them in after setting up Supabase (see README) to sync all three phones.
  supabaseUrl: '',
  supabaseAnonKey: '',
};
