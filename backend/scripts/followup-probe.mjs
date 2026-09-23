// Ticket follow-up probe (read-only, prod). Feeds the /ticket-followups skill.
// Usage: node scripts/followup-probe.mjs <out.json> [--sender vhaeri@bgcengineering.ca] [--workspace 1]
// Prod connection: DATABASE_URL in the environment (the skill passes the az app setting), else
// backend/scripts/.env.prod (PROD_DATABASE_URL=...). The shell profile exports a DEV DATABASE_URL,
// so the host is printed to stderr — the skill refuses to continue unless it is the Azure host.
import { PrismaClient } from '@prisma/client';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith('--'));
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i > -1 ? args[i + 1] : d; };
const sender = String(opt('sender', 'vhaeri@bgcengineering.ca')).toLowerCase();
const ws = Number(opt('workspace', 1));
if (!out) { console.error('usage: followup-probe.mjs <out.json> [--sender email] [--workspace id]'); process.exit(2); }

const url = process.env.DATABASE_URL || (() => {
  try { return readFileSync(path.join(HERE, '.env.prod'), 'utf8').match(/PROD_DATABASE_URL=(.+)/)?.[1]?.trim().replace(/^"|"$/g, ''); } catch { return null; }
})();
if (!url) { console.error('followup-probe: set DATABASE_URL (prod) or backend/scripts/.env.prod'); process.exit(2); }
console.error('followup-probe: db host =', url.replace(/\/\/[^@]*@/, '//***@').split('?')[0]);
const prisma = new PrismaClient({ datasources: { db: { url } } });

// "Human" activity = replies/notes/forwards, EXCLUDING Ticket Pulse's own machine notes
// ("[Ticket Pulse] Assignment auto-assigned…", "[Ticket Pulse mirror]…").
const tickets = await prisma.$queryRawUnsafe(`
  WITH human AS (
    SELECT e.ticket_id, max(e.occurred_at) AS last_human_at
    FROM ticket_thread_entries e
    WHERE e.event_type IN ('reply','public_reply','note','private_note','forward')
      AND COALESCE(e.body_text,'') NOT ILIKE '[Ticket Pulse%'
    GROUP BY e.ticket_id
  ), lastnote AS (
    SELECT DISTINCT ON (e.ticket_id) e.ticket_id, e.occurred_at AS note_at,
      left(regexp_replace(COALESCE(e.body_text,''), '\\s+', ' ', 'g'), 200) AS note
    FROM ticket_thread_entries e
    WHERE e.event_type IN ('reply','public_reply','note','private_note','forward')
      AND COALESCE(e.body_text,'') NOT ILIKE '[Ticket Pulse%'
    ORDER BY e.ticket_id, e.occurred_at DESC
  )
  SELECT tech.id AS tech_id, tech.name AS agent, t.freshservice_ticket_id AS fs, t.id AS tp_id, t.origin,
    left(t.subject, 110) AS subject, t.status, t.priority, t.due_by AS due, t.created_at AS created,
    h.last_human_at, ln.note, ln.note_at,
    EXTRACT(day FROM now() - COALESCE(h.last_human_at, t.created_at))::int AS quiet_days
  FROM tickets t JOIN technicians tech ON tech.id = t.assigned_tech_id
  LEFT JOIN human h ON h.ticket_id = t.id LEFT JOIN lastnote ln ON ln.ticket_id = t.id
  WHERE t.workspace_id = $1 AND tech.is_active = true AND COALESCE(t.is_noise, false) = false
    AND t.status IN ('Open','Pending')`, ws);

const techs = await prisma.$queryRawUnsafe(`
  SELECT tech.id, tech.name, tech.email,
    (SELECT count(*) FROM tickets t WHERE t.assigned_tech_id = tech.id AND t.workspace_id = $1
       AND t.resolved_at >= now() - interval '7 days')::int AS resolved_7d
  FROM technicians tech WHERE tech.workspace_id = $1 AND tech.is_active = true`, ws);

const sig = await prisma.$queryRawUnsafe(`
  SELECT html, spacing FROM user_email_signatures
  WHERE lower(owner_email) = $1 AND enabled = true ORDER BY (workspace_id = $2) DESC LIMIT 1`, sender, ws);

const data = { generatedAt: new Date().toISOString(), workspaceId: ws,
  sender: { email: sender, signatureHtml: sig[0]?.html || null, signatureSpacing: sig[0]?.spacing || 'tight' },
  techs, tickets };
writeFileSync(out, JSON.stringify(data, (k, v) => (typeof v === 'bigint' ? Number(v) : v)));
console.error(`followup-probe: ${tickets.length} open/pending tickets, ${techs.length} active techs, signature ${sig[0] ? 'found' : 'MISSING'}`);
await prisma.$disconnect();
