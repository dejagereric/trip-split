// Browser test: the Content Security Policy allows everything Trip Split uses and blocks the rest.
// External hosts are stubbed; a CSP block happens before any request, so stubs don't hide one.
import { createRequire } from 'node:module'; const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = process.env.TRIPSPLIT_BASE || 'http://localhost:8766/';
const SUPA = 'https://pmutzpswuqvrtkdqplgs.supabase.co';
// Minimal stand-in for supabase-js: no session, so the app shows its sign-in screen.
const FAKE_SB = `export function createClient(){ return {
  auth:{ getSession: async()=>({data:{session:null}}), onAuthStateChange(){return {data:{subscription:{unsubscribe(){}}}}} },
  from(){ const q={select:()=>q,eq:()=>q,order:()=>q,is:()=>q,then:(r)=>r({data:[],error:null})}; return q; },
  rpc: async()=>({data:null,error:null}), storage:{from:()=>({})}, functions:{invoke:async()=>({data:null})} }; }`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

const failures = [];
async function run(label, { localMode }) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const violations = [], external = [], errors = [];
  await page.exposeFunction('reportViolation', (v) => violations.push(v));
  await page.addInitScript(() => document.addEventListener('securitypolicyviolation',
    (e) => window.reportViolation(`${e.effectiveDirective} blocked ${e.blockedURI}`)));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', async (route) => {
    const u = route.request().url();
    if (u.startsWith(BASE)) {
      if (localMode && u.endsWith('/js/config.js')) return route.fulfill({ contentType: 'text/javascript',
        body: "export const CONFIG={defaultCurrency:'USD',supabaseUrl:'',supabaseAnonKey:'',googleClientId:''};" });
      return route.continue();
    }
    external.push(new URL(u).origin + new URL(u).pathname.slice(0, 30));
    if (u.includes('cdn.jsdelivr.net')) return route.fulfill({ contentType: 'text/javascript', body: FAKE_SB });
    if (u.includes('fonts.googleapis.com')) return route.fulfill({ contentType: 'text/css', body: '' });
    if (u.includes('/gsi/client')) return route.fulfill({ contentType: 'text/javascript', body: '' });
    if (/\.png|object\/sign/.test(u)) return route.fulfill({ contentType: 'image/png', body: PNG });
    return route.fulfill({ contentType: 'application/json', body: '{"rate":1.1,"date":"2026-10-17"}' });
  });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  const screen = (await page.locator('#app').innerText()).replace(/\s+/g, ' ').slice(0, 90);

  // Exercise the paths the app uses at runtime, plus one that must be blocked.
  const probes = await page.evaluate(async (SUPA) => {
    const out = {};
    const tryFetch = async (k, url) => { try { await fetch(url); out[k] = 'ok'; } catch { out[k] = 'BLOCKED'; } };
    await tryFetch('supabase api', SUPA + '/rest/v1/trips');
    await tryFetch('frankfurter', 'https://api.frankfurter.dev/v2/rate/eur/usd?date=2026-10-17');
    await tryFetch('google sheets', 'https://sheets.googleapis.com/v4/spreadsheets');
    await tryFetch('evil.example (should block)', 'https://evil.example/steal');
    const img = (src) => new Promise((r) => { const i = new Image(); i.onload = () => r('ok'); i.onerror = () => r('BLOCKED'); i.src = src; });
    out['receipt image (signed url)'] = await img(SUPA + '/storage/v1/object/sign/receipts/x.png');
    const blob = new Blob([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='), c => c.charCodeAt(0))], { type: 'image/png' });
    out['blob: preview image'] = await img(URL.createObjectURL(blob));
    out['image from other host (should block)'] = await img('https://evil.example/x.png');
    try { const m = await import('/js/export.js'); await m.preloadGoogle(); out['google sign-in script'] = 'ok'; } catch (e) { out['google sign-in script'] = 'BLOCKED'; }
    const s = document.createElement('script'); s.src = 'https://evil.example/x.js';
    out['script from other host (should block)'] = await new Promise((r) => { s.onload = () => r('ok'); s.onerror = () => r('BLOCKED'); document.head.appendChild(s); });
    try { eval('1'); out['eval (should block)'] = 'ok'; } catch { out['eval (should block)'] = 'BLOCKED'; }
    out['service worker'] = await navigator.serviceWorker.getRegistration().then((r) => (r ? 'registered' : 'none'));
    return out;
  }, SUPA);
  await page.waitForTimeout(300);
  console.log(`\n===== ${label} =====\nscreen: ${screen}`);
  console.log('external loads allowed by CSP:', [...new Set(external)].join(' | '));
  console.table(probes);
  console.log('violations:', violations.length ? '\n  ' + [...new Set(violations)].join('\n  ') : 'none');
  console.log('page errors:', errors.length ? errors : 'none');
  for (const [k, v] of Object.entries(probes)) {
    const want = k === 'service worker' ? 'registered' : /should block/.test(k) ? 'BLOCKED' : 'ok';
    if (v !== want) failures.push(`${label}: ${k} = ${v} (expected ${want})`);
  }
  [...new Set(violations)].filter((v) => !/evil\.example|eval/.test(v)).forEach((v) => failures.push(`${label}: unexpected CSP block: ${v}`));
  errors.forEach((e) => failures.push(`${label}: page error: ${e}`));
  await browser.close();
}
await run('CLOUD MODE (your real config)', { localMode: false });
await run('LOCAL DEMO MODE', { localMode: true });
console.log(failures.length ? '\n' + failures.length + ' FAILED\n  ' + failures.join('\n  ') : '\nall passed');
process.exit(failures.length ? 1 : 0);
