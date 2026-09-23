---
name: ticket-followups
description: Send Vahid's personal per-person ticket follow-up emails to the IT team, on demand — pulls live Ticket Pulse data, applies his rules (3+ past due, pending quiet 30+ days, urgent/high due this week with no update), writes a warm opener per person in his voice, shows him the recipient list, then sends one email per person FROM his mailbox via Microsoft Graph (lands in his Sent Items). Use when Vahid types /ticket-followups [preview] [yes] [only:<names>] [skip:<names>].
argument-hint: [preview] [yes] [only:<name,name>] [skip:<name,name>]
---

# /ticket-followups — personal "please update your tickets" emails, from Vahid's mailbox

First run: 23 Sep 2026 (12 emails, subject "Your tickets: a few to look at"). Everything that
decides WHO and WHAT lives in tracked code so every run behaves the same; the only judgment each
run is (a) which tickets are already explained by their own note and (b) the per-person openers.

## 0. Parse the prompt
- `preview` → build everything and send Vahid the review copy only. Nobody else gets mail.
- `yes` → Vahid pre-approved: skip the confirmation in step 5 (still show the list in chat).
- `only:<names>` / `skip:<names>` → restrict or drop recipients (first names are fine).
- Default: build, send Vahid the review copy, show the list in chat, and WAIT for his "send".

## 1. Pull live data (read-only)
```
cd C:/Cursor/ticket-pulse-design/backend
DATABASE_URL="$(az webapp config appsettings list -n ticket-pulse-app -g ticket-pulse-rg --query "[?name=='DATABASE_URL'].value | [0]" -o tsv)" node scripts/followup-probe.mjs <scratchpad>/fu.json
```
The stderr banner MUST say `ticket-pulse-pg.postgres…`. `localhost` means the shell profile's dev
DATABASE_URL won (22 Sep lesson) — stop and rerun with the az URL. It must also say `signature found`.

## 2. Candidates + judgment
`python briefs/followups/followups.py candidates <scratchpad>/fu.json`
prints who qualifies, why, and every ticket with its latest human note. Rules (Vahid, 23 Sep —
change them in followups.py, not here):
- email a person if **3+ Open past due**, OR **any Pending with no human update for 30+ days**, OR
  **any Urgent/High Open ticket due within 7 days with no human update at all**;
- only those three kinds of ticket are raised. Tickets due later (RTBT items due Dec 31) are never
  raised just for having no update. "[Ticket Pulse] …" machine notes are not updates;
- test tickets, inactive people and Vahid himself are never included.

Read every printed note. Build an `--exclude` list of FS numbers whose latest note already answers
the question (a clear "waiting on X", "closing in Nov", "linked to the ContinuIT task", a split
notice…). Re-run `candidates --exclude …` and confirm the list still makes sense.

## 3. Write the openers → `<scratchpad>/openers.json`
One entry per qualifying person: `{"<Full Name>": {"open": "...", "asks": {"<fs>": "..."}}}`.
Placeholders `{od}` past due, `{st}` quiet pending, `{un}` urgent, `{res}` resolved in 7 days are
filled by the renderer, so numbers can never drift from the lists.

Voice — memory `vahid-writing-voice`: plain words, warm, direct, no HR-speak. Rules that came from
Vahid's review:
- Open with something genuinely positive when the data supports it (`{res}` closed this week,
  nothing overdue…). Never invent praise.
- **Never rank against colleagues** ("highest in the group"). Their own numbers make the point.
- Name the pattern you actually see (e.g. "mostly onboarding and transfers", "a lot of these may be
  done and just never closed") and keep it soft for heavy queues ("I'd like us to get this under
  control together").
- If the email leads with an urgent ticket, say so in the opener.
- `asks` only where a ticket-specific question beats the default ("Is the Kelowna visit still
  happening? If so, when?"); defaults are "Update, or a new date?" / "Still waiting on something, or
  can it close?" / "Could you add a first update today?".
- Nicknames live in `briefs/followups/nicknames.json` (Muhammad Shahidullah → Mo). Add new ones
  there when Vahid mentions them.

## 4. Render
`python briefs/followups/followups.py render <scratchpad>/fu.json --openers <scratchpad>/openers.json --out <scratchpad>/fu-out --exclude <fs,fs>`
→ one `<email>.html` per person, `review.html`, `recipients.json`. It refuses if anyone lacks an
opener. Every email: "Hi <first>," → the follow-up line → opener → up to 4 tickets per section
(urgent, past due, quiet pending) with Ticket Pulse links only (never FreshService) and "see the full
list" links → the standup ask → "Thanks," → Vahid's full Ticket Pulse signature (logo included).
Apply `only:` / `skip:` by deleting the other files before sending.

## 5. Review, then send
1. Send Vahid the review copy from his own mailbox:
   `node qa/tools/graph-send-as.mjs vhaeri@bgcengineering.ca vhaeri@bgcengineering.ca "Ticket follow-ups: <N> emails ready (not sent yet)" <scratchpad>/fu-out/review.html`
2. Show him the recipient list in chat (name + why) and **wait for an explicit go** unless the prompt
   said `yes`. `preview` stops here.
3. Send, one email per person, stopping at the first failure:
   `node qa/tools/graph-send-as.mjs vhaeri@bgcengineering.ca <email> "Your tickets: a few to look at" <scratchpad>/fu-out/<email>.html`
   Each call must print `202 ACCEPTED … saved to Sent Items`. Never cc anyone.
4. Report: sent N / failed M, the list, and that they are in his Sent Items. Append a line to memory
   `brief-routines` (date, count, subject). If he ran it within the last 3 days, mention the earlier
   run before sending (people shouldn't get two in a week without him choosing to).

## Files
- `backend/scripts/followup-probe.mjs` — read-only prod pull (tickets, techs + 7-day resolved, sender signature).
- `briefs/followups/followups.py` — rules, candidates, renderer.
- `briefs/followups/nicknames.json` — first-name overrides.
- `qa/tools/graph-send-as.mjs` — Graph sendMail as a mailbox (saveToSentItems; data-URI images → inline cid). Uses AZURE_GRAPH_* from backend/.env.
