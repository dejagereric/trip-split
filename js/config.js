// Edit this file before deploying. Everything here is public once on GitHub Pages.
// Trips and people are managed inside the app, not here.
export const CONFIG = {
  // Currency for new trips (each trip can change it).
  defaultCurrency: 'USD',

  // Leave both blank for local demo mode (data stays on one phone, no receipt reading).
  // Fill them in after setting up Supabase (see README) to share trips across phones.
  // The publishable key is meant to be public; row-level security protects the data.
  supabaseUrl: 'https://pmutzpswuqvrtkdqplgs.supabase.co',
  supabaseAnonKey: 'sb_publishable_dLr8vKgiYg1yRcyBSWLWqg_-aMHEr_e',

  // Google OAuth client ID (public) for "Export to Google Sheets". Leave blank to offer CSV only.
  // Create it in Google Cloud: see README → "Google Sheets export".
  googleClientId: '',
};
