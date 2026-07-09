# Accounts Receivable Onboarding — Requirements & Feasibility Analysis

*Source: meeting 2026-06-30 (Kirsten Fanning, Alexa Faerber — Accounting; Vahid Haeri, Susan Xu — IT), transcript in `qa/2026-06-30_AR_meets_accounting_ticketing_-_logistics.txt`. Codebase and prod state audited 2026-07-08 (v3.0.27-preview). **Revised 2026-07-09 after follow-up meeting (Susan/Alexa/Kirsten) — see §0.***

---

## 0. REVISION (Jul 9 follow-up meeting) — what changed

1. **Hard two-week deadline for basic functionality**: assign, distribute, and track AR tickets (manual assignment fine) before Alexa starts training her replacement. Advanced features explicitly deprioritized.
2. **Team prefers keeping the distribution list** — everyone keeps receiving AR mail in their own inbox; they see it as "what AP does, and AP works." Decision framing: the reason the AP DL works with ticketing is that **the intake address is a member of the DL** — ticket systems ingest via membership, not ownership. The same pattern applies to AR with zero disruption and no cutover, which fits the deadline. The shared-mailbox conversion (§5b) is **deferred, not dead** — it becomes relevant again at Phase 3 (collections outbound capture needs a central Sent Items; a DL will never have one).
3. **Second address**: *AR Cambio* (exact address from Alexa pending) must also be captured — both feed the same AR world.
4. **Cross-visibility confirmed**: AR and AP tickets visible to both teams (cross-training) — same workspace, as planned.
5. **Alexa's ~10 category list has been provided** (via Susan) — feed to §5 item 5.
6. Revised recommendation: **fast path = FS route (Option A) for the two-week goal**, with the TP-native capabilities (silent collections, outbound capture) phased in behind it. The one Option-A hazard — FreshService acking AR requesters with "here's your ticket" — is mitigated FS-side: scope the requester *ticket-created* notification (Workflow Automator condition on the intake address/group) so AR stays quiet while AP behavior is unchanged.

**Two-week checklist (Option A):**
- FS admin: add an AR support email + a second for AR Cambio (or alias both into one), each associated to a new **"Accounts Receivable" FS group** in the accounting workspace; add those intake addresses **as members of the existing DLs** (IT/Exchange request — minutes, no cutover).
- FS admin: scope requester ack notifications so AR-group tickets don't ack (AP unchanged).
- TP: publish Alexa's AR categories into the ws2 taxonomy (draft → publish → FS custom-object sync).
- TP: seed skills (Alexa expert on all AR; Ben collections; juniors deposits); onboard Alexa (FS agent seat, since AR tickets will be FS-born on this path).
- TP: canned queue view / group filter for AR; verify AI classification picks the new categories (it runs on FS-born tickets already).
- Nothing else — assignment/tracking/dashboards all work day one on the existing sync.

*The rest of this document is the fuller analysis from the Jun 30 meeting; §4's Option B and §5's feature list remain the Phase-3 path for the collections requirements (R4/R6), which the Jul 9 meeting deprioritized but did not withdraw.*

---

## 1. What they asked for

| # | Requirement | Who / where |
|---|---|---|
| R1 | Bring the **AR shared mailbox** into ticketing, in the **same Accounting workspace as AP** ("we want it within AP ideally… living in the same world is okay") | Kirsten, Alexa |
| R2 | **Mailbox-based segregation**: AR mail is distinguishable from AP (group + categories), no intermingling of client AP/AR matters — but shared dashboard/stats is desired | Alexa ("not confidentiality… just don't want it to intermingle") |
| R3 | **Two work streams with different automation postures**: (a) **Remittances/deposits** — high-volume, repetitive, fine to automate, assign to 2-3 juniors; (b) **Collections** — sensitive, PM/client/legal threads, pre-assigned to one senior (Ben), manual control | Kirsten, Alexa, Susan's summary |
| R4 | **No requester-facing "ticket" noise for collections**: no "here's your case number / you've been queued" emails to PMs or clients, no visible ticket-system tone. Case numbers internally are fine | Alexa ("tone-wise… awkward conversations"), Kirsten ("please give us money, we've put you in queue") |
| R5 | **Per-mailbox notification settings**: AR behaves differently than AP *"without turning it off for AP"* | Alexa, Kirsten (explicit) |
| R6 | **Outbound-initiated cases**: Alexa sends collection notices *from the AR mailbox*; the PM/client reply lands back in AR and must attach to the same case — **not** spawn a new ticket per reply, and not notify anyone automatically | Kirsten's scenario walkthrough |
| R7 | **AR categories**: small taxonomy — "Accounts Receivable" umbrella; at minimum **Remittances** and **Collections** separated; Alexa to send a list (5–10) | All |
| R8 | **Assignment maturity curve**: manual first (Alexa triages/assigns while training people), semi-automatic suggestions next, ~80-90 % automated eventually ("Kirsten doesn't have to look every day") | Kirsten, Vahid |
| R9 | **Skills seeding without history**: AR has no ticket history — Alexa starts as the expert on everything AR; juniors built up manually as they train | Kirsten |
| R10 | **Onboard Alexa** (only new person; the other ~5 AR mailbox users are already in the system) | Kirsten |
| R11 | Volume: AR ≈ 10–15/day (vs AP ≈ 186/week) — low risk pilot size | Kirsten |
| Parked | BST export button, OCR invoice extraction (AP wish), auto-extracting variables from emails | Kirsten — explicitly pinned for later |

---

## 2. What we have today (audited)

**Prod state (ws2 "Accounting Team"):**
- `nativeTicketingEnabled = false`; **zero** TP mailbox connections anywhere in prod (feature deployed, never used in prod).
- One FS group: **"Accounts Payable"**. Groups/`group_members`/`category_group_links` tables exist in prod; internal-group membership unused so far.
- 11 active top categories — **all AP-flavored** (post-reorg taxonomy). No AR categories.
- 15 active technicians incl. Kirsten and Benjamin Rabel ("Ben"). Alexa not onboarded.
- **All ws2 TP notification workflows are disabled** → AP's current auto-acknowledgements come from **FreshService**, not Ticket Pulse.
- ~315 AR-ish tickets that historically leaked into the AP mailbox were tagged during the July reorg (exportable again if needed).

**Capabilities already built (relevant):**
- **Multi-mailbox ingestion per workspace** (`MailboxConnection`): unlimited mailboxes, Microsoft Graph (app permissions), per-mailbox `mode` (ingest/send/both), poll interval, **`defaultGroupId` (FS group) or `defaultInternalGroupId` (TP group)** routing, default ticket type. Full Settings UI (Ticket Mailboxes panel). Gated by `nativeTicketingEnabled`.
- **Reply threading** on ingest: In-Reply-To/References → thread-entry Message-IDs, TP-#### subject refs, sender+recency heuristic; FS `#12345` refs deliberately skipped to avoid duplicating FS-ingested mail.
- **TP-born tickets are silent by default** — nobody gets emailed unless a TP notification workflow explicitly sends. Workflows have AND/OR conditions (source, category, tags, requester domain, business-hours…), confidence-gated AI replies, templates.
- **Internal groups with membership** + local (non-FS) agents — an agent seat without a FreshService license, valid for TP-born tickets only.
- **AI triage pipeline** runs automatically on mailbox-born tickets (classify → priority → type → recommend); `AssignmentConfig.excludedGroupIds` can force *pending-review* (manual) for a specific group while others auto-assign.
- **Hierarchical category editor** (draft → publish → FS sync → AI reclassify) — already live for ws2 since v3.0.17.
- **FS fallback mirror**: TP-born tickets mirror to FreshService as backup copies.

---

## 3. Requirement-by-requirement fit

| Req | Verdict | How |
|---|---|---|
| R1 same workspace | ✅ exists | Add AR to ws2 — either as an FS mailbox+group, or a TP mailbox connection |
| R2 segregation | ✅ exists | AR group (FS or internal) + AR categories; queue group filters, canned views, per-group stats already work |
| R3 two postures | ✅ mostly exists | `excludedGroupIds` forces manual review for a collections group while remittances auto-assign — needs the AR groups to exist; finer *per-category* auto-assign policy is a small extension |
| R4 no ticket-noise for collections | ✅ **if TP-native** / ⚠️ hard if FS-ingested | TP-born = silent by default. FS-ingested = FreshService sends its own acks; carving out "quiet for AR only" means fighting FS notification rules outside our app |
| R5 per-mailbox notification settings | ⚠️ small gap | TP workflows can't condition on *mailbox/group* yet — conditions know source/category/tags but not "arrived via ar@". **Build: add group/mailbox condition field** (small, generic) |
| R6 outbound-initiated cases | ❌ **the real gap** | Nothing captures mail *sent from* the shared mailbox today. **Build: per-mailbox Sent-Items capture** — outgoing mail from the AR mailbox creates a silent case; later replies thread onto it via Message-ID (threading machinery already exists). Generic feature, useful to any workspace |
| R7 AR taxonomy | ✅ exists | Waiting on Alexa's list; add via the hierarchical editor (draft/publish/FS-sync). Recommend: 1 top "Accounts Receivable" area with subs, or 2–4 tops (Remittances & Deposits, Collections, AR Inquiries, …) |
| R8 maturity curve | ✅ exists | Manual → review-queue suggestions → auto-assign is exactly the existing pipeline's dial |
| R9 skill seeding | ✅ exists | Manual competency assignment in Skill Matrix (Alexa = expert everywhere AR; Ben = collections; juniors = deposits). No history needed |
| R10 onboard Alexa | ✅ exists | FS agent seat *or* a TP **local agent** (no FS license) if we go TP-native — she does zero AP work, so local fits |
| R11 volume | ✅ | 10–15/day is an ideal pilot size |

---

## 4. The one decision that shapes everything: how AR mail becomes tickets

**Option A — FS route (clone of AP today).** Add the AR mailbox to FreshService, FS email-to-group rule → new "Accounts Receivable" FS group, TP syncs as usual.
- ✅ Proven pipeline end-to-end; zero new infrastructure.
- ❌ FreshService sends its acknowledgment emails to AR requesters — the collections requirement (R4) then depends on suppressing FS notifications per-group *inside FS*, which is fragile and invisible to our app. ❌ No outbound capture (R6) — FS can't do it either. ❌ Replies to collection notices would create fresh FS tickets (the exact failure Kirsten described).

**Option B — TP-native route (recommended).** Enable `nativeTicketingEnabled` on ws2; add the AR mailbox as a TP `MailboxConnection` (mode `both`), routed to an AR group. AR tickets are TP-born; AP continues exactly as today via FS.
- ✅ Silent by default — collections get case numbers with zero requester-facing noise; any acks we *do* want (e.g. a gentle remittance confirmation) are opt-in TP workflows we fully control.
- ✅ Reply threading already built; send-as-AR from the ticket composer already built (so threads stay in AR, not Alexa's personal box — her own stated wish).
- ✅ The Sent-Items capture feature (R6) is only possible on this route.
- ✅ FS still gets mirror copies (fallback), and Alexa can be a local agent (no FS license needed).
- ⚠️ Risks: TP mailbox ingestion has **never run in prod** (0 connections) — AR's low volume makes it the ideal pilot, but we should shadow-run it 1–2 weeks (Vahid already proposed exactly this in the meeting); needs Graph application permissions on the AR mailbox (IT-side M365 config); prod hasn't exercised internal-group membership yet.

A hybrid also works: start Option A for day-1 continuity, build B behind it — but that double-migrates the team and postpones the features they actually asked for. Given AR isn't in any ticket system today (no continuity to preserve), going straight to B is cleaner.

---

## 5. Feature work (generic first, then AR-flavored config)

**New build (the "4–8 weeks" Vahid quoted):**
1. **Outbound mail capture per mailbox** *(the novel feature — medium)*: Graph subscription/poll on Sent Items; an email sent from the shared mailbox by a human creates a silent TP case (requester = the external recipient, assigned to the sender if mappable); subsequent replies thread on. Per-mailbox toggle + sensible loop-guards (ignore TP's own sends, ignore replies already threaded).
2. **Workflow conditions on group / mailbox** *(small)*: expose `ticket.group` (and/or arrival mailbox) in the condition builder so "AR behaves differently than AP" is plain workflow configuration — reusable by every workspace.
3. **Per-mailbox default category** *(small)*: `defaultCategoryId` on MailboxConnection so AR mail lands pre-tagged "Accounts Receivable" even before AI classification.
4. **Per-category auto-assign policy** *(small-medium, can defer)*: today the manual/auto dial is per-group; a per-category override ("Remittances auto, Collections manual") completes R3 — the group-level dial covers the training period fine.

**Configuration / data work (no code):**
5. AR taxonomy from Alexa's list → draft/publish in the category editor → FS custom-object sync.
6. AR group(s) + membership: likely two — *AR Deposits* (juniors) and *AR Collections* (Ben) — or one group with category-level split.
7. Skills seeding in Skill Matrix; Alexa onboarded (local agent if Option B).
8. **Historical mailbox analysis**: you export the AR shared mailbox; we run the same Haiku classification harness used in the AP reorg over it to validate the taxonomy, discover the "weird one-off" long tail, and pre-familiarize categorization. Also tells us sender/PM patterns for the outbound-capture design.

**Suggested phasing:**
- **Phase 0 (now):** mailbox prerequisite below (DL → shared mailbox) + Alexa's category list + history export/analysis; Graph permissions request for the AR mailbox.
- **Phase 1:** taxonomy + groups + skills + Alexa onboarded; AR mailbox connected in *shadow mode* (ingest on, everything manual, zero outbound emails) — the 1–2 week observation window.
- **Phase 2:** conditions-on-group + per-mailbox category; enable manual assignment workflow for the team; remittance auto-suggestions on.
- **Phase 3:** Sent-Items capture for collections; then gradually raise automation (auto-assign remittances to the junior pool).

---

## 5b. Mailbox prerequisite: `accountsreceivable@` is an on-prem DL, not a mailbox

Confirmed 2026-07-09 (Entra portal): **Source = Windows Server AD, Type = Distribution, 6 assigned members**, created 2019. A DL has no message store — nothing for Graph to poll, no Sent Items for outbound capture, no central archive. Mail today fans out to the 6 members' personal inboxes (which is why replies live in Alexa's inbox). And because it's synced from on-prem AD, Exchange Online's one-click *Convert to shared mailbox* is unavailable — it must be **recreated as a shared mailbox at the same SMTP address**.

**Runbook (recreate, hybrid-safe):**

*Prep — no user impact:*
1. **Export history first**, while the mail is still in personal inboxes: Purview content search `participants:accountsreceivable@bgcengineering.ca` across the org → export. (Alexa's inbox alone likely covers most of it.) This feeds the taxonomy-validation analysis.
2. Inventory the DL before touching it: `Get-DistributionGroup … | fl PrimarySmtpAddress, EmailAddresses, LegacyExchangeDN, GrantSendOnBehalfTo, AcceptMessagesOnlyFrom*, RequireSenderAuthenticationEnabled` — **capture `LegacyExchangeDN`** (needed below) and every alias.
3. Create the replacement mailbox. Hybrid-correct method: **`New-RemoteMailbox -Shared` on-prem** with a temp alias (keeps the object synced/managed on-prem and guarantees mail routing works regardless of whether inbound flow transits on-prem Exchange). Cloud-only `New-Mailbox -Shared` is fine *only if* MX/inbound flow goes straight to EXO — Sam will know the topology.
4. Grant the 6 members **Full Access + Send As**; set **`Set-Mailbox … -MessageCopyForSentAsEnabled $true -MessageCopyForSendOnBehalfEnabled $true`** so replies sent *as* AR land in the shared **Sent Items** — this single setting is load-bearing for the collections outbound-capture feature.

*Cutover — short after-hours window:*
5. Delete the DL in on-prem AD (or strip its mail attributes / move out of sync scope) → force a delta AAD Connect sync → confirm the DL object is gone from EXO.
6. Move `accountsreceivable@bgcengineering.ca` onto the shared mailbox as **primary SMTP** (keep the temp alias as secondary).
7. **Add an X500 address equal to the old DL's `LegacyExchangeDN`.** Without it, internal senders replying to *old* AR emails (PMs replying to past collection notices — the exact core scenario) get IMCEAEX bounce-backs, because Outlook's autocomplete cache resolves the old DN, not the SMTP address.

*Post-cutover:*
8. Members' Outlook auto-maps the shared mailbox (Full Access) — the current manual workflow continues unchanged while TP shadow-runs.
9. Optionally import the Purview export into the shared mailbox so the historical record lives centrally at the address.
10. Grant TP's app registration Graph `Mail.Read` + `Mail.Send`, scoped with an **ApplicationAccessPolicy** to this one mailbox.

**Zero-risk bridge (optional):** before the cutover, the temp-alias shared mailbox can simply be **added as a member of the existing DL** — it then receives copies of all AR mail, letting TP shadow-ingest for a week or two with production flow untouched. Discard the bridge at cutover. (This membership trick is a fine *bridge* but a bad *end state*: everyone still gets everything, replies stay personal, no central Sent Items.)

---

## 6. Open questions for the next meeting

1. Confirm the **two-group split** (Deposits vs Collections) vs one AR group + category-level behavior.
2. For remittances: do they want *any* acknowledgment email to the payer, or fully silent? (Silent is the default; an ack is a one-workflow opt-in.)
3. Collection notices: confirm the team will send **from the AR mailbox** going forward (Alexa leaned yes) — outbound capture only sees what's sent from the shared box.
4. Should PM/client replies **reopen** a resolved collections case automatically? (We have a reopen-on-reply workflow, currently disabled.)
5. M365 admin: who grants Graph `Mail.Read`+`Mail.Send` application access to the AR mailbox?
6. Alexa's seat: FS license or TP local agent? (Local works if she stays AR-only and AR is TP-born.)
7. The "Cameo" mailbox Kirsten mentioned in passing — in scope or later?
8. Who owns the Exchange/AD change for the DL→shared-mailbox recreation (§5b), and when's the cutover window? Does inbound mail flow transit on-prem Exchange (decides `New-RemoteMailbox` vs cloud-only)?

---

## 7. Explicitly out of scope for this round (parked, per Kirsten)
- BST export button / integration.
- OCR extraction of invoice fields (Amazon/Instacart totals, invoice numbers) — noted that TP's email analysis could attempt field extraction as variables; revisit after AR lands.
