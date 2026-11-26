import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';

// 25 Nov 2026: ticketpulse.bgcsi.com is the main address; index.html forwards the old one.
const here = dirname(fileURLToPath(import.meta.url));
const htmlSrc = readFileSync(join(here, '../../index.html'), 'utf8');
const scripts = [...htmlSrc.matchAll(/<script>\s*([\s\S]*?)<\/script>/g)].map((m) => ({ body: m[1], at: m.index }));
const forward = scripts.find((s) => s.body.includes('location.replace'));

function run(href) {
  const url = new URL(href);
  const replaced = [];
  const win = {};
  const location = {
    hostname: url.hostname, pathname: url.pathname, search: url.search, hash: url.hash,
    replace: (to) => replaced.push(to),
  };
  new Function('location', 'window', forward.body)(location, win);
  return { to: replaced[0] || null, moving: win.__tpMovingHost === true };
}

describe('index.html old-address forward', () => {
  test('is the first script, before the theme script and /src/main.jsx', () => {
    expect(forward).toBeTruthy();
    expect(scripts[0]).toBe(forward);
    expect(forward.at).toBeLessThan(htmlSrc.indexOf("localStorage.getItem('tp_theme')"));
    expect(forward.at).toBeLessThan(htmlSrc.indexOf('src="/src/main.jsx"'));
  });

  test('names only the old host and only the new host as the target', () => {
    expect(forward.body).toContain("location.hostname === 'ticketpulse.bgcsaas.com'");
    expect(forward.body).toContain("'https://ticketpulse.bgcsi.com' + location.pathname + location.search + location.hash");
  });

  test('keeps the path, query and hash of every old link', () => {
    expect(run('https://ticketpulse.bgcsaas.com/tickets/4821?peek=1#reply')).toEqual({ to: 'https://ticketpulse.bgcsi.com/tickets/4821?peek=1#reply', moving: true });
    expect(run('https://ticketpulse.bgcsaas.com/it/TP-10000').to).toBe('https://ticketpulse.bgcsi.com/it/TP-10000');
    expect(run('https://ticketpulse.bgcsaas.com/ticket-status/abc123').to).toBe('https://ticketpulse.bgcsi.com/ticket-status/abc123');
    expect(run('https://ticketpulse.bgcsaas.com/approval/tok').to).toBe('https://ticketpulse.bgcsi.com/approval/tok');
  });

  test('leaves every other host alone', () => {
    for (const href of [
      'http://localhost:5173/tickets/1',
      'https://brave-dune-056d0421e.azurestaticapps.net/tickets/1',
      'https://ticketpulse.bgcsi.com/tickets/1',
      'https://api.ticketpulse.bgcsaas.com/',
      'https://x.ticketpulse.bgcsaas.com/',
    ]) {
      expect(run(href)).toEqual({ to: null, moving: false });
    }
  });
});
