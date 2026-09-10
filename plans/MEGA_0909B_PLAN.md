# MEGA 09-09b — QA package + the reply-loop root cause

**Train:** v3.8.48 → v3.8.51 · **Baseline:** origin/main is `3.8.47-preview` (frontend) / `3.8.46-preview` (backend)
**Source:** `qa/9-9 Package/Features Request - 09-09.docx` (Kirsten, Susan, Marcus) + tonight's mailbox investigation
**Status legend:** `[ ]` todo · `[x]` done · `[~]` in progress · `[!]` blocked

---

## Why this train exists

QA item #2 — *"I replied to the agent through Outlook, but the requester's reply did not get updated to the
conversation thread on Ticket Pulse"* — is not a threading bug. It is the visible symptom of a mailbox that
was never connected. Susan's reply arrived exactly where it was addressed and sat there unread. Everything
in Phase 0 follows from that, and the New Hire automation turned up on the way.

**Evidence chain (all verified against prod tonight):**

| Fact | Evidence |
|---|---|
| IT (ws1) has no ingest mailbox | `mailbox_connections` holds exactly one row: `patickets@` on ws5 |
| IT's TP-born replies send as `ticketpulse@` with Reply-To null | v3.8.40 send path; 95 TP-born IT tickets, 0 inbound replies recorded |
| Requester replies *do* arrive | `ticketpulse@` inbox: 60 messages, 59 unread, 5 of them genuine replies to TP tickets |
| Susan's TP-1252 reply is one of them | "Yes, I received it." — Wed 2026-09-09 10:40, still unread |
| Graph can already read the mailbox | `mailFolders/inbox` → `INBOX READABLE — items=60` |
| `ittickets@` cannot be used | Not a UPN (404 `Request_ResourceNotFound`), not a proxy address on any mailbox — it is an Exchange **mail contact** pointing at FreshService, so it has no inbox to read |

---

## Phase 0 — Close the reply loop (prod config, no code) `[x]` DONE

Fixes QA #2. Do this first: it is the highest-value change in the train and needs no deploy.

- [x] **0.1** Verify the ingest watermark mechanism — confirm a newly connected mailbox can start from "now"
      rather than replaying all 60 historical messages. If no watermark exists, add one before connecting.
      → No code change needed — a fresh connection already looks back only 15 minutes (`FIRST_LOOKBACK_MS`), and `_bootstrapDelta` filters its initial round the same way and deliberately does not ingest it.
- [x] **0.2** Insert the ws1 `mailbox_connections` row, mirroring the proven ws5 config:
      `address: ticketpulse@bgcengineering.ca`, `mode: 'both'`, `is_enabled: true`, `is_primary: true`,
      `new_ticket_policy: 'hold_unmatched'`, `agent_cc_intake: true`, `notification_status: 'active'`.
      → Created: connection id 2, watermark set to 2026-09-09T17:00Z so activation picked up only Susan’s two replies.
- [x] **0.3** Confirm outbound now carries a Reply-To / plus-address for ws1 TP-born replies
      (`plusAddressReplyTo` + `threadingHeadersForTicket`) — this is what makes future replies thread.
      → `pickIngestMailbox(1)` and `pickOutboundMailbox(1)` both return ticketpulse@ (mode=both) — future IT replies carry the plus-address Reply-To.
- [x] **0.4** Recover the 5 orphaned replies already in the inbox (TP-1252, TP-1192, TP-1167 and two others)
      onto their tickets, or hand Susan the list so she can answer them by hand. **Do not** let the
      backfill create tickets.
      → Susan’s 2 (TP-1252) ingested automatically on the first poll. The other 3 are on CLOSED/DELETED QA test tickets (TP-1167, TP-1192, TP-1204) — nothing real was lost, no backfill needed.
- [x] **0.5** End-to-end test: reply to a TP-born IT ticket from Outlook → confirm it lands on the thread.
      → Verified in prod: entries 3127661 (17:41 “Yes, I received it.”) and 3127662 (17:48) now on TP-1252. No stray tickets, 0 held, no errors.

**Cross-workspace safety (already verified):** PA's notification mail also returns to this box.
`matchEmailToTicket` is scoped strictly to `connection.workspaceId`, so a ws5 reply arriving at a
ws1-connected mailbox cannot misfile into IT — it fails to match, classifies as `external_reply_unknown`,
and goes to the hold queue for a human. It holds; it does not guess.

### Phase 0b — the noise rule that must land with it `[x]` DONE

- [x] **0b.1** Add a ws1 noise rule so FreshService's own notification mail cannot become IT tickets:

      name:           FreshService Notification Echo
      pattern:        ^\[(?:INC|SR)-\d+\]
      senderPattern:  ^it@bgcengineering\.ca$
      category:       system
      autoCloseFromPeople: false   (leave default)

      → Rule id 86 created. NOTE: first write was mangled by shell escaping (stored `^[(?:INC|SR)-d+]`); repaired via a script file to `^\[(?:INC|SR)-\d+\]` / `^it@bgcengineering\.ca$`.
- [x] **0b.2** Verify behaviour: rule fires → ticket created, flagged `is_noise`, auto-closed
      (ws1 is the only workspace with `auto_close_noise = true`) and visible in **Noise & spam**. Nothing dropped.
      → 7-case matrix passes: FS notifications match; a real reply, a human forward of the same mail, a plain subject and an OOF all correctly do NOT match.

**Why it is needed.** FS notification mail carries no TP reference and no reply headers, so it reads as
`fresh` and *creates a ticket*. There is already one full lap on the record: INC-237697 is `origin='ticketpulse'`
— a TP-born ticket that mirrored to FreshService, whereupon FreshService emailed `ticketpulse@` about it.
Today that dead-ends in an unread inbox. Connect the mailbox and it returns as a new ticket, which mirrors
again. The `senderPattern` is load-bearing: if a person forwards the same `[INC-…]` mail because they
actually want something done, the sender will not match and their ticket lives.

**Verified:** `it@bgcengineering.ca` is not a requester and has filed no ordinary tickets, so
`_requesterLooksHuman` returns false and the auto-close is permitted by the v3.8.32 person guard.

---

## Phase 1 — v3.8.48 · Removing a Cc must actually remove it `[x]` DONE

Fixes QA #6 (Marcus). **The most serious item in the package — it sends mail to people an agent
deliberately excluded.**

**Root cause (confirmed in code).** `ticketService.js:170` `unionReplyCc()` returns the **union** of the
ticket's "Also for" list and the composer's Cc. `_addThreadEntry` calls it for every public reply
(`ticketService.js:3682`). `alsoForNotifyService.js` states the intent plainly: *"reply emails ALWAYS reach
the list regardless."* So when an address is in **both** the composer Cc and the ALSO FOR list — which is
exactly Marcus's ticket TP-1262 — removing the chip changes nothing. The union puts it straight back.

The safety net is deliberate and worth keeping (an address added to the ticket *after* the draft was opened
must still be reached). The bug is that it cannot tell "never in the draft" from "the agent took this off".

- [x] **1.1** Add an explicit `ccRemoved` field to the reply payload: addresses the agent deliberately
      removed from the seeded Cc.
      → `threadBodySchema.ccRemoved` (emailListSchema, defaults to []). Omitting it keeps the old union behaviour exactly.
- [x] **1.2** `unionReplyCc(ticket, composerCc, ccRemoved)` — subtract `ccRemoved` from the union.
      Late-added additional requesters still get through; deliberate removals stick.
      → Implemented in ticketService.js; call site at _addThreadEntry passes parsed.data.ccRemoved.
- [x] **1.3** Frontend: track removals against the seed in `TicketDetail.jsx` and send them.
      → Derived at send time from ccSourceForReply(ticket) − composerCc, guarded by ccSeededRef. NOTE: buildThreadPayload’s multipart branch appends a fixed field list — ccRemoved had to be named there too, or a reply with an attachment would silently drop the removals.
- [x] **1.4** UX: when the removed address is an **additional requester**, say what actually happened —
      removing them from this one reply does not remove them from the ticket. Offer both.
      → Hint under the Cc row naming who won’t get this reply and pointing at Also for.
- [x] **1.5** Tests: removal honoured; late-added ALSO FOR address still reached; API v1 replies
      (which never seed) unchanged.
      → 9 backend (unionReplyCc), 4 frontend (payload incl. multipart), 3 frontend (ccSourceForReply). All green; existing TicketDetail.ccVisibility 8/8 still pass.
- [x] **1.6** Ship v3.8.48 + changelog.
      → Changelog entry written; frontend+backend package.json at 3.8.48-preview. Committing with Phases 2–4 as one PR / one deploy.

---

## Phase 2 — v3.8.49 · Accounting's real invoices are being dismissed `[ ]`

Fixes QA #1 (Kirsten). Verified against prod — her three examples reproduce exactly, and both decisions
were machine-made (`decided_by_email` is null):

| Ticket | Sender | Decision | Kirsten is right |
|---|---|---|---|
| #241154 "New Invoice from Instacart Business" | noreply@getbalance.com | `duplicate_dismissed` | not a duplicate |
| #241127 "Tytan Safety Invoice" | nancy@tytanglove.ca | `duplicate_dismissed` | not a duplicate |
| #241020 "Your TELUS Business payment authorization…" | donotreply@telus.com | `noise_dismissed` | not noise |

**Scale — ws2, last 30 days:** 76 `duplicate_dismissed`, 431 `noise_dismissed`. The duplicate dismissals
cluster on exactly the vendors you would expect: **getbalance/Instacart 17**, **Starlink 10**, **FedEx 5**,
Citi 3, Agnico Eagle 3.

**Root cause A — the never-noise veto does not guard the duplicate door.**
`detectBurstDuplicate` matches on *exact normalized subject + same requester + within 15 minutes*. It was
built for a real incident (the FreshService Teams app creating 12 copies in 84 seconds) and its own comment
admits the limit: *"subjects … differ only in the body, which the guard never reads."* Vendor invoices break
the assumption — Instacart sends several genuinely different invoices with an identical template subject
minutes apart. Worse, the guard runs at `assignmentPipelineService.js:186`, **before and independently of**
`evaluateNeverNoise` (line 1559). Someone already wrote `never_noise` rules for Instacart, Starlink, FedEx
and "Financial Documents" — all four sit at **0 hits**, because the tickets they were meant to protect are
dismissed through a different door.

**Root cause B — TELUS.** `is_noise` is false and no ws2 rule matches the subject, so `noise_dismissed`
came from the AI pipeline's own judgement, not a rule. Accounting's guidance is not holding for vendor
payment notifications — which in AP *are* the work, not noise.

- [ ] **2.1** Consult `evaluateNeverNoise` **before** any duplicate-burst dismissal. A never-noise ticket
      must not be auto-dismissed through any door. Cheap, principled, reuses config that already exists.
- [ ] **2.2** Strengthen `detectBurstDuplicate`: require body/attachment similarity, not subject alone.
      A template subject with different attachments is not a burst.
- [ ] **2.3** Immediate mitigation while 2.1/2.2 land: consider `duplicateBurstEnabled = false` for ws2
      (the per-workspace switch already exists at `assignmentConfig.duplicateBurstEnabled`).
- [ ] **2.4** Give agents a **"Not a duplicate"** undo on the ticket, so this is self-service next time.
- [ ] **2.5** Re-open / re-triage Kirsten's named tickets and the 17 getbalance + 10 Starlink dismissals.
- [ ] **2.6** Root-cause B: why Accounting's noise guidance is not protecting vendor payment mail.
- [ ] **2.7** Ship v3.8.49 + changelog.

---

## Phase 3 — v3.8.50 · Three UI fixes `[ ]`

- [ ] **3.1 (QA #3) Assign on split.** `SplitTicketModal.jsx` — add an assignee control beside Cancel
      ("Assign to…" / "Leave unassigned") so the agent does not have to reopen the new ticket. Default to
      leave-unassigned; remember nothing.
- [ ] **3.2 (QA #4) ALSO FOR chip overflows its border.** `TicketDetail.jsx` — a long address
      (`bgcengineeringcait@efusion.freshservice.com`) runs past the container edge. Constrain the chip:
      `min-w-0` + truncate with the full address on hover/title, and let the row wrap. Check the composer
      Cc chips for the same defect.
- [ ] **3.3 (QA #7) "No access" → "Basic access."** `MembersPanel.jsx:177`. The current label is
      misleading: technicians with no app grant can still sign in for their own queue, which is not
      "no access". Update the description to match, and the tests at `MembersPanel.test.jsx:105,126`.
- [ ] **3.4** Visual verification of all three (real CSS, real components).
- [ ] **3.5** Ship v3.8.50 + changelog.

---

## Phase 4 — v3.8.51 · Merge notes invisible on Ticket Pulse `[ ]`

Fixes QA #5 (Kirsten): after split → close → merge back, FreshService shows the private notes about the
merge and Ticket Pulse shows none.

`ticketMergeService.js` **does** write both notes (step 4 target, step 6 source) — but both calls are
`.catch()`-ed as non-fatal, and `addPrivateNote` routes FS-born tickets through FreshService.

- [ ] **4.1** Reproduce on an FS-born parent (her case was #241413) and determine whether the note is
      written to FS only, written locally but not rendered, or silently swallowed by the `.catch()`.
- [ ] **4.2** Fix so merge notes are visible on both origins.
- [ ] **4.3** Stop silently swallowing the failure — a merge note that cannot be written should surface.
- [ ] **4.4** Ship v3.8.51 + changelog.

---

## Phase 5 — Deploy & verify `[ ]`

- [ ] **5.1** Full backend (Jest) + frontend (Vitest) suites, `npm run lint:dark`.
- [ ] **5.2** Diff `changelog.js` + both `package.json` against `origin/main` **before** bumping —
      another session is shipping on this worktree (they took 3.8.47 tonight).
- [ ] **5.3** Deploy; verify `/health` version on `ticket-pulse-app.azurewebsites.net` and the bundle
      marker on `https://ticketpulse.bgcsaas.com/assets/index-*.js`.
- [ ] **5.4** Confirm Phase 0 is still healthy after deploy (ingest running, nothing stray created).

---

## Phase 6 — QA response PDF `[ ]`

Standard branded response next to the request file, with pictures, markers and pointers.

- [ ] **6.1** One section per QA item (#1–#7): what they reported, what was actually wrong, what changed.
- [ ] **6.2** Annotated before/after screenshots for the UI items.
- [ ] **6.3** **The New Hire automation section — for the conversation with Sam Khadem** (below).
- [ ] **6.4** Render, verify, and report the full absolute path.

### 6.3 — New Hire automation: findings for Sam

Your read was right. Verified tonight:

**What is happening**
- There is a FreshService **agent** account named "Ticket Pulse" (`id 1002090730`,
  `ticketpulse@bgcengineering.ca`, created 2026-04-13). It is **not** the Ticket Pulse application —
  the name collision is itself part of the confusion.
- The New Hire automation authenticates with that account's API key and creates tickets through the
  FreshService API: **146 of 149** carry `source = 1001`, which FreshService's own field metadata
  resolves to **"API"**. Two tickets per hire (NH Laptop + NH Workstation).
- It does not set a requester on create, so FreshService defaults the requester to the API caller.
  Every one of these tickets is therefore filed as requested by "Ticket Pulse" — which is why the
  notification emails open with *"Hello Ticket,"*.
- **151 tickets** in IT since 2026-05-04, still running — the most recent were created today.

**Why it matters**
1. **The new hire never hears anything.** Every FreshService status update ("assigned to…", "resolved")
   is addressed to the requester, so it goes to `ticketpulse@` — a mailbox nobody reads — instead of to
   the person waiting for their laptop.
2. **IT's reporting is skewed.** 151 tickets are attributed to a person who does not exist. Requester
   counts, top-requester lists and per-person analytics are all off by that much.
3. **It becomes a feedback loop the moment Phase 0 lands.** Those notifications turn into inbound tickets.
   Phase 0b closes that door, but the door should not need closing.

**The fix is upstream and small.** The automation already knows who the ticket is for — the identity is
right there in the subject (`NH Laptop - Ottawa - CA - RGraham - 2026-09-28`). The FreshService ticket-create
API accepts `email` or `requester_id`; passing the new hire's address is a one-line change that fixes all
three consequences at once.

**Two things worth raising in the same conversation (not blockers):**
- The "Ticket Pulse" automation account holds **Admin / entire_helpdesk** plus four Business Agent roles
  across five workspaces. That is far more than creating onboarding tickets requires.
- Separately, and unrelated to Sam: **Ticket Pulse's own FreshService integration authenticates as Vahid's
  personal account** (`agents/me` → `1000011793`, vhaeri@bgcengineering.ca). Every FS write the app makes is
  attributed to Vahid, and the integration breaks if that account's key is ever rotated. This belongs on a
  dedicated service account.

---

## Parking lot — raised, not scheduled

- [ ] `ticketpulse@` should not be the requester on 151 onboarding tickets (upstream — Sam).
- [ ] PA's notification and auto-reply traffic returns to `ticketpulse@` rather than `patickets@`, because
      notification mail goes through SendGrid on the global From instead of Graph-as-`patickets@`.
      Those ws5 OOF replies land in the wrong box.
- [ ] 17 tickets whose `requester_id` FK disagrees with `requester_freshservice_id` (14 in ws1, 3 in ws4) —
      a genuine mis-link, small and separate from the 151.
- [ ] Long term: mint a real `ittickets@` **mailbox** matching the ARTickets/APTickets/PATickets convention
      when IT is ready for TP to be primary, and retire the shared `ticketpulse@` address for IT.
- [ ] Accounting still owes ten confirmed wrong noise dismissals (the panel generates the list).
- [ ] Assetron: contract sign-off, category names, credential handover, IP-allowlist decision.
- [ ] 22 requester merge candidates (alias row + owner's own row) — needs a human decision.
