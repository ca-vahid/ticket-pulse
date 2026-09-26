#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Switch the Assetron laptop integration on (or off) in production.
 *
 *   node scripts/assetron-switch-on.mjs --client-id <Assetron prod API client id> [--dry]
 *   node scripts/assetron-switch-on.mjs --off [--dry]
 *
 * Sets ASSETRON_API_BASE_URL and ASSETRON_API_SCOPE in ONE App Service change
 * (every settings change restarts the app), waits for /health, then says how
 * to confirm the connection.
 * Needs the Azure CLI signed in with rights on ticket-pulse-rg.
 */
import { execFileSync } from 'node:child_process';

const APP = 'ticket-pulse-app';
const RG = 'ticket-pulse-rg';
const BASE_URL = 'https://assetron-api-cpdafzgqc6fecpgd.canadacentral-01.azurewebsites.net/api/v1';
const HEALTH = `https://${APP}.azurewebsites.net/health`;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const dry = flag('--dry');
const off = flag('--off');
const clientId = value('--client-id');
const az = (...a) => execFileSync(process.platform === 'win32' ? 'az.cmd' : 'az', a, { encoding: 'utf8', shell: process.platform === 'win32' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!off && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId || '')) {
  console.error('Give the Assetron PROD API client id: --client-id xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx (or --off)');
  process.exit(1);
}

// No --query: on Windows the CLI runs through the shell, which mangles it.
const current = JSON.parse(az('webapp', 'config', 'appsettings', 'list', '-n', APP, '-g', RG, '-o', 'json'))
  .filter((s) => s.name.startsWith('ASSETRON_')).map(({ name, value: v }) => ({ name, value: v }));
console.log('Now:', current.length ? current.map((s) => `${s.name}=${s.value}`).join('  ') : '(not set)');

if (off) {
  console.log(`Will remove: ${current.map((s) => s.name).join(', ') || 'nothing'}`);
  if (dry || !current.length) process.exit(0);
  az('webapp', 'config', 'appsettings', 'delete', '-n', APP, '-g', RG, '--setting-names', ...current.map((s) => s.name), '-o', 'none');
} else {
  const scope = `api://${clientId}/.default`;
  console.log(`Will set:  ASSETRON_API_BASE_URL=${BASE_URL}  ASSETRON_API_SCOPE=${scope}`);
  if (dry) process.exit(0);
  az('webapp', 'config', 'appsettings', 'set', '-n', APP, '-g', RG, '--settings', `ASSETRON_API_BASE_URL=${BASE_URL}`, `ASSETRON_API_SCOPE=${scope}`, '-o', 'none');
}
const changedAt = Date.now();
console.log('Settings saved — the app restarts now. Waiting for /health…');

let up = false;
for (let i = 0; i < 60 && !up; i++) {
  await sleep(10_000);
  try {
    const h = await (await fetch(HEALTH)).json();
    up = typeof h?.uptime === 'number' && h.uptime * 1000 < Date.now() - changedAt + 5_000 && h?.checks?.database?.status === 'healthy';
    if (up) console.log(`Back: ${h.app?.version}, uptime ${Math.round(h.uptime)} s`);
  } catch { /* restarting */ }
}
if (!up) { console.error('The app did not come back within 10 minutes — check the portal.'); process.exit(1); }
if (off) process.exit(0);

console.log(`
Switched on. Check it now (about a minute after boot):
  1. The app log shows "Assetron connected: filter-options answered with N filters"
     — or "Assetron connection check failed — 401/403 …" (401 = wrong scope/client id,
     403 = the role grant is missing on Assetron's side).
  2. On any ticket: Approvals → Request approval → New Computer Upgrade → tick
     "Reserve a new laptop from Assetron". Filters appear = token + role + URL all work.
  3. With Sam: reserve one laptop, then cancel the request → Assetron shows it back to NEW.
Roll back any time: node scripts/assetron-switch-on.mjs --off`);
