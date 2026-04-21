// Quick smoke test for the demo-mode scrubber. Runs against representative
// payloads modelled on the screenshots provided by the user (Dashboard,
// Technician Detail, Timeline Explorer, Assignment Review).
//
// Usage:  node scripts/test-demo-scrub.mjs
//
// Exits non-zero with a diff if any sensitive token leaks through.
//
// Note: this script polyfills the few browser globals our runtime depends on
// (localStorage, sessionStorage, crypto.getRandomValues, fetch) so the
// modules can be imported in plain Node.

import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';

// --- polyfills ----------------------------------------------------------
class MemStorage {
  constructor() { this._m = new Map(); }
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }
  setItem(k, v) { this._m.set(k, String(v)); }
  removeItem(k) { this._m.delete(k); }
  clear() { this._m.clear(); }
  get length() { return this._m.size; }
  key(i) { return Array.from(this._m.keys())[i] || null; }
}
globalThis.localStorage = new MemStorage();
globalThis.sessionStorage = new MemStorage();
if (!globalThis.crypto) globalThis.crypto = webcrypto;
// fetch: pretend the manifest doesn't exist so getDemoAvatar returns null
// and the scrubber strips photoUrls to ''.
globalThis.fetch = async () => ({ ok: false });

// Enable demo mode before importing (some modules read it eagerly).
localStorage.setItem('tp_demoMode', 'true');

const __filename = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(__filename), '..');
const modulePath = pathToFileURL(path.join(root, 'frontend/src/utils/demoMode/index.js')).href;
const { scrubResponse, isDemoMode, mapName } = await import(modulePath);

if (!isDemoMode()) {
  console.error('Demo mode failed to enable.');
  process.exit(1);
}

// --- sample payloads ----------------------------------------------------
const samples = {
  dashboard: {
    technicians: [
      {
        id: 1,
        name: 'Andrew Fong',
        email: 'andrew.fong@bgcengineering.ca',
        location: 'Toronto',
        timezone: 'America/Toronto',
        photoUrl: 'https://internal/photo/andrew.jpg',
        tickets: [
          { freshserviceTicketId: 218491, subject: 'New Hire: Mahmoud Al-Riffai', requesterName: 'BambooHR Notifications', requesterEmail: 'notifications@app.bamboohr.com', ticketCategory: 'Onboarding' },
          { freshserviceTicketId: 215329, subject: 'MS Suite issues', requesterName: 'Dan Parker', requesterEmail: 'dparker@bgcengineering.ca', ticketCategory: 'Software Support' },
        ],
      },
      {
        id: 2,
        name: 'Anton Kuzmychev',
        email: 'anton.kuzmychev@bgcengineering.ca',
        location: 'Vancouver',
        photoUrl: 'https://internal/photo/anton.jpg',
        tickets: [
          { freshserviceTicketId: 214567, subject: 'BGC-KAM-HV02 - Error: Transfer has failed for BGC-KAM-FILE2', requesterName: 'Anton Kuzmychev', ticketCategory: 'Backup / Restore' },
        ],
      },
    ],
  },
  timeline: {
    events: [
      { ticketId: 35076, subject: '#35076 - First access credential added to Application or Service Principal where one credential was present involving Muhammad Shahidullah', performedByName: 'Muhammad Shahidullah', _techPhotoUrl: 'https://internal/photo/muhammad.jpg' },
      { ticketId: 81355, subject: '#81355 - Darktrace: 87.0 - Antigena/Network/Significant Anomaly/Antigena Controlled and Model Breach', performedByName: 'Anton Kuzmychev' },
    ],
  },
  assignments: {
    runs: [
      { id: 1, subject: 'Re: Jacobs Federal Contract Cybersecurity Questionnaire - BGC ENGINEERING USA INC', requesterName: 'Alvin Lau', agentName: 'Anton Kuzmychev', aiSuggestionRationale: 'Based on history with BGC Engineering tickets, Mehdi Abbaspour is recommended.' },
      { id: 2, subject: 'Cant open the file from N-drive', requesterName: 'Bigul Pokhareli', agentName: 'Adrian Lo' },
    ],
  },
};

// --- pre-seed known people (so free-text scrub catches them in subjects) -
const knownTechs = ['Andrew Fong', 'Anton Kuzmychev', 'Adrian Lo', 'Mehdi Abbaspour', 'Muhammad Shahidullah', 'Reza Zaim', 'Sohell Naslri', 'Gaby Tonnova'];
for (const t of knownTechs) mapName(t);

// --- run the scrubber ---------------------------------------------------
const dashboard = scrubResponse(JSON.parse(JSON.stringify(samples.dashboard)));
const timeline = scrubResponse(JSON.parse(JSON.stringify(samples.timeline)));
const assignments = scrubResponse(JSON.parse(JSON.stringify(samples.assignments)));

console.log('\n=== DASHBOARD ===');
console.log(JSON.stringify(dashboard, null, 2));
console.log('\n=== TIMELINE ===');
console.log(JSON.stringify(timeline, null, 2));
console.log('\n=== ASSIGNMENTS ===');
console.log(JSON.stringify(assignments, null, 2));

// --- assertions ---------------------------------------------------------
const flat = JSON.stringify({ dashboard, timeline, assignments });
const banned = [
  'Andrew Fong', 'Anton Kuzmychev', 'Adrian Lo', 'Mehdi Abbaspour',
  'Muhammad Shahidullah', 'Mahmoud Al-Riffai', 'Dan Parker', 'Alvin Lau',
  'Bigul Pokhareli',
  'BGC', 'bgcengineering.ca', 'BGC ENGINEERING',
  'BGC-KAM-HV02', 'BGC-KAM-FILE2',
  'Toronto', 'Vancouver',
  'andrew.fong', 'dparker',
];

const leaks = banned.filter(token => flat.includes(token));
if (leaks.length > 0) {
  console.error('\nLEAKED tokens still present after scrub:', leaks);
  process.exit(2);
}

// --- second-pass: verify mapping is stable -----------------------------
const dashboard2 = scrubResponse(JSON.parse(JSON.stringify(samples.dashboard)));
if (dashboard.technicians[0].name !== dashboard2.technicians[0].name) {
  console.error('\nUNSTABLE mapping: same real name produced two different fake names.');
  console.error(`  first run:  ${dashboard.technicians[0].name}`);
  console.error(`  second run: ${dashboard2.technicians[0].name}`);
  process.exit(3);
}

// Verify photoUrl was scrubbed (since manifest is empty, becomes '')
const photoSamples = [dashboard.technicians[0].photoUrl, timeline.events[0]._techPhotoUrl];
for (const p of photoSamples) {
  if (p && p.startsWith('https://internal/')) {
    console.error('\nLEAKED real photoUrl:', p);
    process.exit(4);
  }
}

console.log('\nOK: no sensitive tokens leaked, mapping is stable, photo URLs scrubbed.');
