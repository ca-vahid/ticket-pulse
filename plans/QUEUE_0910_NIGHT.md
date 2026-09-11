# Queue — night of Sep 10/11, 2026

Three items raised by Vahid today. **Nothing here is implemented yet.** Items 1 and 2 wait for
the feature-request file; item 3 is blocked on a decision, noted below.

---

## 1. Quote the whole conversation on outbound replies `[ ]`

> *"there is actually a thread happening and everything, but when the agent replies … I only get
> the last part, which is confusing. We need the entirety of the ticket context in a new format at
> the bottom, as if it's been an email thread."*

### What exists today

`ticketService._lastInboundQuote(ticketId, excludeEntryId)` (Phase RL-8, ~line 4183) appends
**exactly one** quoted message under every outbound reply:

```
where: { ticketId, incoming: true, isPrivate: false,
         OR: [{ source: 'email_inbound' }, { authorType: 'requester' }] }
orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }]   // newest only
```

Rendered as `<hr>` + `On <date>, <who> wrote:` + a `<blockquote>`, sanitized, capped at 20 KB, with
a `> `-prefixed plain-text twin. Applied on BOTH lanes (the Graph createReply draft's own quote is
overwritten by our PATCH, so this is the only quote either lane carries).

So the requester sees: the agent's new message, plus **their own last message** — and nothing else.
No ticket description, no earlier exchanges, none of the agent's own prior replies. That is exactly
the "only the last part" complaint.

### The five things that make this harder than it looks

1. **Internal notes must never leak.** `isPrivate: false` is the only thing standing between a
   requester and the team's internal notes. Any full-thread query MUST preserve it, and it should
   be asserted in a test that fails loudly — this is the highest-severity risk in the whole item.
2. **The thread is full of things that are not messages.** `ticket_thread_entries` carries
   `activity`, `status_event`, `assignment_event`, `group_event`, private notes, split/merge system
   notes, and `[Ticket Pulse mirror]` markers. A naive "all entries" select dumps system noise into
   a customer email. Filter to real messages: public replies + inbound mail + the description.
3. **Quote-on-quote growth.** Verified tonight: inbound bodies are stored **with the sender's own
   quoted history intact** — there is no reply-chain stripper (`forwardedMailParser.js` only parses
   forwards). Today that is harmless because we quote one message. Quote the full thread and every
   round trip re-quotes an ever-larger body: message N carries N copies. **This is the one that
   will bite.** Options: quote from stored entries only and cap total size; strip quoted blocks
   from inbound bodies on ingest (`blockquote`, `gmail_quote`, `-----Original Message-----`,
   `On … wrote:`); or both. Prefer both.
4. **Size.** 20 KB per message today. A full thread needs a per-message cap AND a total cap, with
   an explicit "…earlier messages omitted" marker rather than silent truncation.
5. **Client rendering.** Inline styles only — no classes survive email clients. Gmail collapses
   quoted history behind "…" using its own heuristics; we cannot force it, but wrapping each block
   in `<blockquote>` and the whole history in a `gmail_quote`-classed div gives clients their best
   chance. Outlook will show it inline; that is fine and expected.

### Shape I would propose

Replace `_lastInboundQuote` with `buildThreadQuote(ticketId, excludeEntryId, { maxMessages, maxBytes })`:

- Select public messages only — `isPrivate: false` AND an event type in a message allowlist —
  newest first, plus the ticket description as the final (oldest) block.
- Render newest-first under an `<hr>`, each with `On <date>, <who> wrote:` and a nested-look
  blockquote, matching the existing single-quote styling so nothing changes visually for the
  first block.
- Cap: ~8 messages / ~60 KB total, then `<p>[…earlier messages omitted — see TP-1279…]</p>` with a
  link to the ticket.
- Keep the plain-text twin in step.
- Ingest-side: strip quoted history from inbound bodies so the stored entry is just what the person
  actually wrote. Do this in the same release or item 1 regresses itself.

**Verify with:** a thread of ≥4 alternating messages, a thread containing an internal note (assert
it is absent from the wire), a thread with an inbound reply that itself contains a quote, and a
>60 KB thread.

---

## 2. `<p>` tags shown literally in the FreshService note `[ ]`

> Screenshot: a private note reading `<p>Juan Gonzalez (Digital Solutions Lead) is asking…</p><p>…</p>`

### Root cause — found, not guessed

`freshServiceActionService.js:267` builds an **HTML** note body and inserts the briefing raw:

```js
const messageHtml = briefing || legacyReasoning || '';
let noteBody = `<b>[Ticket Pulse]</b> Assignment ${decisionLabel}.<br>`;
if (messageHtml) noteBody += `${messageHtml}<br>`;
```

That is correct *provided* `agentBriefingHtml` holds real HTML. For run **24271** it holds
**already-escaped** HTML:

```
&lt;p&gt;Juan Gonzalez (Digital Solutions Lead) is asking to have Azure billing re-enabled…
```

Escaped entities inside an HTML note render as visible `<p>` text. Confirmed in prod.

### Scope

Last 30 days, runs with a non-null `agentBriefingHtml`:

| `agentBriefingHtml` contains a raw `<p>` | runs |
|---|---|
| yes (renders correctly) | 3,490 |
| no (escaped or plain) | **128** |

So ~3.5% of notes. Not every note, but a steady trickle, and it looks broken to whoever reads it.

### Fix direction

Two layers, both worth doing:
- **At the source:** find why `agentBriefingHtml` is persisted escaped for some runs — most likely
  the model returns escaped markup and it is stored verbatim. Normalise on write.
- **Defensively at the seam:** in `freshServiceActionService`, decode entities before inserting
  when the value looks escaped (`&lt;p&gt;` present and no raw `<`). Cheap, and it repairs the 128
  existing runs on any re-sync.

Check the same seam for the **noise-dismissal closure notice** just below it — it uses the same
`briefing || legacyReasoning` pattern and will have the same defect.

---

## 3. Agent name on outbound mail for PA and every other workspace `[!] BLOCKED — needs a decision`

> *"fix this for project accounting and any other workspace too so the outgoing email would show
> the agent name and not 'ticket pulse'."*

**IT (ws1) is fixed** — `mode: 'both'` → `'ingest'`, which moves replies back to SendGrid where the
agent's display name survives. IT's SendGrid sender is `ticketpulse@bgcengineering.ca`, which is
also what its mailbox was, so nothing else changed.

**PA (ws5) cannot take the same fix as-is.** SendGrid always sends from the global
`SMTP_FROM_EMAIL` = `ticketpulse@bgcengineering.ca`; there is no per-workspace from **address**
(`workspace_email_identities` carries `from_name` only). So switching ws5 to `ingest` would:

- fix the display name → the agent's name, but
- change PA's sender from `patickets@bgcengineering.ca` to `ticketpulse@bgcengineering.ca`

That is a worse trade for Project Accounting — a different team's address on their mail, and
requester-side filters/rules pointed at `patickets@` would stop matching.

### Why it cannot simply be done on the Graph side

`graphMailClient.sendMailAsMailbox` **does** set `from: { emailAddress: { address, name } }` — the
agent's name is already being sent. Exchange rewrites it to the mailbox's directory display name on
delivery. Vahid's screenshot is the proof: Soheil's name went out, "Ticket Pulse" arrived. Not
fixable in our code.

### The clean fix (small, but it is a code change)

`sendgridNotificationService.sendEmail` already accepts a `from` override
(`const fromAddress = trim(from) || sendgridConfig.fromEmail`) — the native-reply call simply never
passes one. Pass the workspace's connected mailbox address as `from`, falling back to the global.
Then every workspace gets: **its own sender address + the agent's display name + plus-address
Reply-To**, which is strictly better than either lane today.

### The blocker

This only works if SendGrid is authorised to send as `patickets@bgcengineering.ca`. If the account
uses **domain authentication** for `bgcengineering.ca`, any address at the domain works and this is
safe. If it uses **single-sender verification**, only `ticketpulse@` is allowed and PA mail would
start bouncing.

I could not determine which: the credential in App Service is an SMTP password, and the SendGrid
API rejected the whitelabel/domains lookup with `access forbidden`. **Needs either a SendGrid
console check (Settings → Sender Authentication) or a full-permission API key.**

**Do not switch ws5 to `ingest` until that is answered.** Leaving it on `both` means PA keeps its
correct sender address and a wrong display name — the safer of the two failures.
