# Ticket Types Plan — per-workspace type registry, LLM descriptions, type-aware SLAs

**Status: IMPLEMENTED — v3.0.49-preview (PR #160) + v3.0.50-preview (PR #161, 2026-07-12).**
All phases landed; migration + seed applied to dev and prod; live type write-back verified in
all four workspaces. v3.0.50 went further than the plan: SLAs are now **per-type only** (the
'All types' fallback was removed per product direction — the ws1 generic Urgent row was
replicated per-type and deleted) and **Pending pauses the SLA clock** (no overdue chips/counts/
segments/triggers for pending tickets). Remaining follow-ups: analytics type dimension
(deferred, §5) and the team's answer on Accounting's future types (open question #1).
Originally written 2026-07-12 from a live FS probe + exhaustive code audit.

---

## 1. The problem

Ticket Pulse assumes every workspace uses IT's two types — `Incident` and `Service Request`.
That vocabulary is **hardcoded in at least 9 independent places** across backend and frontend.
It happens to work for IT and silently misbehaves everywhere else.

### What FreshService actually has (probed live 2026-07-12, `backend/scripts/probe-fs-ticket-types.mjs`)

| TP ws | Name | FS ws | FS Type choices (authoritative) | Observed on last 100 tickets | In our DB |
|---|---|---|---|---|---|
| 1 | IT | 2 | **Incident, Service Request, Major Incident** | 52 Incident / 48 Service Request | 553 Inc / 558 SR / 17k null (pre-backfill) |
| 2 | Accounting Team | 4 | **Case** | 100 Case | 11,806 Case / 588 null |
| 3 | Health & Safety | 5 | **Request** | 100 Request | 233 Request / 3.9k null |
| 4 | Field Equipment | 7 | **Request** | 100 Request | 91 Request / 319 null |

Facts that shape the design:

- **Type lists are per-FS-workspace and admin-editable** (`GET /ticket_form_fields?workspace_id=N`,
  field `ticket_type`, each choice has a stable numeric id). They can drift at any time —
  Accounting may add "Urgent Change" or "Breakfix" tomorrow, or never.
- **Type is optional for agents in every workspace** (`required_for_agents=false`, no default) —
  a ticket can legitimately have `type=null`. Any SLA matching must tolerate that.
- **IT already has a third type we never handle**: `Major Incident` exists in FS today. Our Zod
  schemas would reject it on a TP-side edit, and the LLM can never assess it.
- FS `type` is a free-text string on the ticket API; only the form-field choices constrain it.
  Our DB column is `VarChar(40)` free-text too — good, no DB migration needed for new values.

### What our app does today (audit summary, file:line)

**Hardcoded `['Incident', 'Service Request']` literals — no shared constant, no workspace awareness:**

| # | Site | Effect when wrong |
|---|---|---|
| 1 | `backend/src/services/ticketTypeAssessment.js:3` (`FRESHSERVICE_TICKET_TYPES`) + alias map + `normalizeTicketType` throws on anything else | LLM assessment can never say "Case"; normalizer rejects valid FS values |
| 2 | `backend/src/services/assignmentTools.js:255-267` — recommendation tool schema `enum` + the incident-vs-request definition prose (this prose IS the classification prompt) | Accounting/H&S runs are asked to pick between two IT concepts that don't exist in their workspace |
| 3 | `backend/src/services/ticketService.js:71` — create schema, **`.default('Incident')`** | A native Accounting ticket cannot be a "Case" and silently defaults to "Incident" |
| 4 | `backend/src/services/ticketService.js:107` — update schema | Editing type on a ws2 ticket to its own workspace's value is rejected |
| 5 | `backend/src/routes/tickets.routes.js:356-359` — mailbox `defaultTicketType` validation | Can't configure AR@/AP@ mailboxes to birth "Case" tickets |
| 6 | `frontend/src/pages/TicketCreate.jsx:18` — toggle group, orange/violet styling | ws2 create form offers Incident/Service Request only |
| 7 | `frontend/src/pages/TicketDetail.jsx:39` — sidebar select (has a graceful fallback `<option>` for legacy values) | Existing "Case" shows via fallback but the dropdown offers the wrong menu |
| 8 | `frontend/src/components/tickets/TicketFilterRail.jsx:37` — `TYPE_OPTIONS` facet | ws2/ws3/ws4 users get filter options that match zero tickets, and no "Case"/"Request" facet |
| 9 | `frontend/src/components/settings/MailboxConnectionsPanel.jsx:225-226, 302-303` — hardcoded `<option>`s | Same as #5, UI side |

**Structural assumptions beyond the literals:**

- `frontend/src/components/tickets/ticketUi.jsx:123-142` — `TypePill` is **binary**:
  `/incident/i` → orange "INC", *everything else* → violet "REQ". Accounting's 11.8k Cases all
  render as "REQ" today; a future "Breakfix" would too. "Major Incident" happens to match
  `/incident/i` and renders as a plain INC — losing exactly the distinction that matters.
- `AssignmentReview.jsx:123-134, 2421-2424, 3149-3152` — badges only special-case `isIncident`.
- **SLA is priority-only.** `sla_policies` is `@@unique([workspaceId, priority])`
  (schema:462-476); `slaPolicyService.dueDatesFor(workspaceId, priority)` (45-52) never sees
  type; `TicketOpsPanel.jsx` renders exactly 4 priority rows. This is the user-visible pain:
  **you cannot give "Major Incident" a 30-min response SLA and "Case" a 2-day one.**
- **LLM assessment runs for ALL workspaces** (`assignmentPipelineService.js:1149`,
  unconditional — unlike priority which is config-gated at 1140-1148) and persists
  `assessedTicketType` — so Accounting runs are already writing IT-vocabulary assessments into
  `tickets.assessed_ticket_type` on ws2 rows. **Write-back is env-gated to ws1 only**
  (`freshServiceActionService.js:521` → `workspaceFeatureFlags.js` `SKILL_HIERARCHY_WORKSPACE_IDS`,
  default `'1'`) — an env var, invisible in the UI, and it conflates type write-back with the
  category skill-hierarchy feature.
- **Analytics is type-blind** — zero references in `analyticsService.js` / `Analytics.jsx`.
  No demand-mix-by-type view exists anywhere.
- **Workflow conditions have no ticket-type field** — the condition builder can route on
  source, priority, category, custom fields… but not type. (SLA triggers `sla_pre_breach` /
  `sla_breach` exist and will automatically benefit from type-aware SLAs.)
- **Mirror path:** TP-born tickets mirror to FS with whatever `ticketType` string we hold;
  FS accepts arbitrary strings on the ticket API, but values outside the FS workspace's choice
  list render inconsistently in FS UI. A TP-native type therefore needs an explicit FS mapping
  (or an explicit "don't send" rule).
- Storage is already sane: `tickets.ticket_type` + separate `assessed_ticket_type` +
  rationale/confidence/audit columns (schema:724-729), write-back bookkeeping on runs
  (schema:2298-2301). `VarChar(40)`, no DB enum — **the registry below is config, not a
  data migration.**

---

## 2. Design — `ticket_type_definitions` registry

One new table: the per-workspace catalogue of ticket types. Native to TP; each entry **may or
may not** map to an FS type choice (default: it does). Everything that currently hardcodes the
two-type list reads this instead.

```prisma
// Per-workspace ticket-type catalogue. TP-native; optionally mapped to a
// FreshService ticket_type choice. Retire (isActive=false), never delete —
// historical tickets keep their string value.
model TicketTypeDefinition {
  id            Int      @id @default(autoincrement())
  workspaceId   Int      @map("workspace_id")
  workspace     Workspace @relation(fields: [workspaceId], references: [id])
  name          String   @db.VarChar(40)          // canonical value stored on tickets.ticket_type
  description   String?  @db.Text                  // LLM classification guidance + human tooltip
  aliases       String[] @default([])              // normalizer inputs ("sr", "breakfix", "issue")

  // FreshService mapping. null = TP-native-only type: kept on TP tickets,
  // never written to FS (mirror + write-back skip with an explicit status).
  fsTypeValue   String?  @db.VarChar(40) @map("fs_type_value")
  fsChoiceId    BigInt?  @map("fs_choice_id")      // from ticket_form_fields; drift detection
  fsDetectedAt  DateTime? @map("fs_detected_at")   // last time FS still offered this choice

  aiAssignable  Boolean  @default(true)  @map("ai_assignable")  // LLM may pick it (Major Incident: false)
  isDefault     Boolean  @default(false) @map("is_default")     // preselected on TP-born create
  color         String   @default("slate") @db.VarChar(20)      // pill accent: orange|violet|red|blue|emerald|slate…
  abbreviation  String?  @db.VarChar(6)                          // pill text ("INC","SR","CASE","MAJ")
  sortOrder     Int      @default(0) @map("sort_order")
  isActive      Boolean  @default(true) @map("is_active")
  source        String   @default("fs_sync") @db.VarChar(20)    // fs_sync | manual
  createdAt     DateTime @default(now()) @map("created_at")
  updatedAt     DateTime @updatedAt @map("updated_at")

  @@unique([workspaceId, name])
  @@map("ticket_type_definitions")
  @@index([workspaceId, isActive])
}
```

Design decisions and why:

- **`name` is the stored value.** `tickets.ticket_type` stays a string (17k+ historical rows,
  FS interop, CSV export all keep working). The registry validates and describes; it does not
  re-key. Renaming a type = retire + create; the old string remains renderable via the
  unknown-value fallback that TicketDetail already has.
- **`description` is the LLM contract.** Today the only classification guidance is one
  hardcoded sentence in the tool schema (`assignmentTools.js:258`). Per-type, per-workspace
  descriptions let Accounting say what a "Case" vs a future "Breakfix" means in *their* domain,
  exactly like competency descriptions do for routing. Editable in Settings, used verbatim in
  the tool schema.
- **`fsTypeValue`/`fsChoiceId` nullable = the native-TP escape hatch** the user asked for:
  a workspace can define a type FS doesn't have (yet). Guards at both write paths
  (mirror + assessment write-back) skip FS for unmapped types with an explicit skipped-status,
  never a 400.
- **`aiAssignable`** — IT's "Major Incident" must exist for humans and SLAs but the pipeline
  must not be able to declare one. Default true; seed Major Incident false.
- **Retire-don't-delete** (`isActive`) — same lesson as the AP category reorg.
- **`source`** distinguishes FS-synced rows (drift detection may touch) from manual rows
  (drift detection must not).

### FS sync + drift detection

New `ticketTypeSyncService`:

1. On workspace sync (piggyback the existing daily/periodic config pass — NOT per-ticket) fetch
   `GET /ticket_form_fields?workspace_id=<fsWsId>`, extract `ticket_type` choices.
2. Upsert: new FS choice → create definition (`source:'fs_sync'`, `aiAssignable:true`,
   description empty → flagged "needs description" in Settings). Existing match (by `fsChoiceId`,
   fallback name) → bump `fsDetectedAt`.
3. FS choice gone → **do not deactivate** (tickets still carry it); set a `fsMissing` derived
   state (fsDetectedAt stale) and surface a warning chip in Settings.
4. FS ticket arrives with a type string not in the registry (transformer path) → store it
   verbatim as today, and auto-register an inactive `source:'fs_sync'` definition so it shows
   up in Settings as "detected, unconfigured" instead of being invisible.

### Seed (migration + script, dev AND prod before merge)

From the probe: ws1 Incident (orange/INC, default) + Service Request (violet/SR) +
Major Incident (red/MAJ, `aiAssignable:false`); ws2 Case (blue/CASE, default); ws3+ws4
Request (violet/REQ, default). Seed descriptions for ws1 from the existing schema prose;
leave ws2-4 descriptions minimal for the teams to refine. Include current alias map on ws1.

---

## 3. Type-aware SLAs

The motivating requirement: different SLAs per type ("Major Incident" ≠ "Case").

**Schema** — additive, on `sla_policies`:

```prisma
ticketTypeId  Int?  @map("ticket_type_id")   // null = fallback: applies to any type
// replace @@unique([workspaceId, priority]) with @@unique([workspaceId, priority, ticketTypeId])
```

(Postgres treats NULLs as distinct in unique indexes — enforce the single-fallback-row rule with
a partial unique index `WHERE ticket_type_id IS NULL` in the migration SQL, since Prisma can't
express it.)

**Matching** — `dueDatesFor(workspaceId, priority, { ticketTypeId | typeName }, from)`:

1. exact `(workspace, priority, ticketTypeId)` active policy;
2. else fallback `(workspace, priority, ticketTypeId=null)` — today's rows become exactly this,
   so **the migration is behavior-preserving**: existing policies keep applying to everything
   until someone adds a type-specific override;
3. `type=null` tickets (FS allows it) always use the fallback row.

**Callers to update:** TP-born create path (`ticketService` create → dueBy), and re-evaluate
dueBy when `ticketType` changes on a TP-born ticket (today an edit from Case→Breakfix would
keep the Case deadline — decide: recompute only if dueBy was SLA-derived and not manually set;
store a `dueBySetBy` marker if needed). SLA workflow triggers (`sla_pre_breach`/`sla_breach`)
read `dueBy` and need no change.

**UI (`TicketOpsPanel.jsx`)** — from 4 fixed priority rows to a matrix: rows = priority,
columns/tabs = type (from registry) + "All types" fallback column. A type column starts empty
("inherits All types") until a value is set — sparse config, no forced duplication.

---

## 4. Workspace-aware LLM assessment

- **Tool schema per run:** `assignmentTools` builds the `ticketType` property from the
  workspace's active `aiAssignable` definitions: `enum` = names, description = concatenated
  per-type descriptions ("Case — day-to-day AR/AP correspondence…; Breakfix — …").
  Single-type workspaces (Accounting today): **skip the enum question entirely** and
  auto-stamp the type — no tokens spent asking the LLM to pick from a list of one.
- **Normalizer:** `normalizeTicketType(value, workspaceId)` validates against the registry
  (+ per-type aliases). The global two-value constant dies.
- **Write-back gating moves from env var to config:** new `typeWritebackEnabled` on
  `AssignmentConfig` (per workspace, next to `autoCategorizeEnabled` in Settings → AI & Routing),
  seeded true for ws1 to preserve behavior; `SKILL_HIERARCHY_WORKSPACE_IDS` stays for the
  category/skill features it also gates but stops controlling type. Write-back only sends
  types with `fsTypeValue` (else `skipped: not_mapped_to_freshservice`). Observe-mode carve-out
  semantics mirror categories: observed groups record the assessment; write-back only if the
  workspace's observe-apply flag says so.
- **Assessment persistence stays universal** (it's harmless audit data), but with the registry
  the persisted values are finally the workspace's own vocabulary.

---

## 5. Everything else that consumes type (full coverage)

| Surface | Change |
|---|---|
| **API** | `GET /api/ticket-types` (workspace-scoped, active-first, includes retired for filter labels). Admin CRUD under settings routes. Types piggyback the workspace bootstrap payload so ticket pages don't add a request. |
| **Zod create/update** (`ticketService.js:71,107`) | Enum → async registry validation. Create default = workspace's `isDefault` row (NOT 'Incident'). |
| **TicketCreate** | Toggle group from registry (name, color); >4 types degrade to a select. Default from registry. Template presets (`TicketTemplate.ticketType`) validated against registry on save. |
| **TicketDetail** | Sidebar select from registry; keep the legacy-value fallback option. |
| **TypePill** (`ticketUi.jsx:123`) | Definition-driven: abbreviation + color from registry (pass a types map via context/hook); unknown values keep a neutral slate pill with the raw string — kill the binary `/incident/i`. |
| **TicketFilterRail** | `TYPE_OPTIONS` → registry (+ "No type" facet — thousands of null-type rows exist). |
| **Mailbox connections** (routes:356, panel:225) | Validate + offer registry values; AR/AP mailboxes can birth "Case". |
| **AssignmentReview / PipelineRunDetail / LivePipelineView / TicketAiTab** | Replace `isIncident`-only badges with the generic pill; writeback chips unchanged (status strings already generic). |
| **Workflow conditions** | Add `ticket.type` condition field (choices from registry) in the condition builder — the gap that blocks "notify manager on Major Incident". Cheap: conditions compile to json-logic over ticket fields already. |
| **Analytics (later, optional)** | Type as a demand-mix dimension (Overview split, Demand & Flow facet). Explicitly deferred — not needed for SLA correctness. |
| **CSV export, run selects, transformer** | No change (free strings flow through). |
| **Mirror fallback copies** | TP-born mirror sends `fsTypeValue ?? omit` (never an unmapped native name). |
| **Tests** | Update the hardcoded-expectation tests (`freshServiceActionService`, `assignmentRecommendationValidation`, `PipelineRunDetail.priority.test.jsx`); add registry-service, SLA-matrix-fallback, and per-workspace-tool-schema tests. |

### Data hygiene (prod, before/at rollout)

- **ws2-4 `assessed_ticket_type` pollution:** IT-vocabulary assessments already persisted on
  non-IT rows. One-time script: null out `assessed_ticket_type` (+ rationale/confidence) where
  the value isn't in that workspace's registry — they were never written to FS (env gate) so
  this is TP-side cleanup only.
- **Null backfill (optional):** `backfill-ticket-types.mjs` already exists for the 17k/3.9k
  null rows; re-run per workspace if filter/analytics accuracy warrants.

---

## 6. Phases (each independently shippable)

1. **Registry + seed + API** — table, migration (dev+prod BEFORE merge, per convention),
   seed script from probe data, sync/drift service, `GET /ticket-types`. No consumer changes;
   zero behavior change.
2. **Settings UI** — Ticket Ops → "Ticket types": list, add/edit (name, description, color,
   abbreviation, default, aiAssignable, FS mapping), retire, drift warnings
   ("FS offers 'Major Incident' — unconfigured"), needs-description nudge.
3. **Validation + creation surfaces** — Zod → registry, create/detail/filter/mailbox/template
   consumers, TypePill generalization. (First user-visible change; Accounting can finally
   create Cases natively.)
4. **Type-aware SLA** — schema + partial unique index, `dueDatesFor` fallback chain, matrix UI,
   dueBy recompute rule.
5. **LLM per-workspace** — tool schema from registry, normalizer, single-type short-circuit,
   `typeWritebackEnabled` config (replaces env gate for type), assessed-type cleanup script.
6. **Workflow condition + polish** — `ticket.type` condition, review-surface pills, tests,
   analytics dimension if/when wanted.

Rollout risk notes: phases 1-2 are inert; phase 3 changes the create default per workspace
(verify ws1 default stays Incident); phase 4's migration must convert existing rows to
fallback rows (`ticket_type_id=null`) — behavior-preserving by construction; phase 5 flips
ws1's gate from env to config — seed `typeWritebackEnabled=true` for ws1 in the migration so
no behavior change on deploy.

---

## 7. Open questions for the team

1. **Accounting taxonomy:** do they want "Urgent Change"/"Breakfix" as *types* (SLA-bearing,
   FS-synced) or is that better modeled as priority + category? The registry supports either;
   someone should ask before seeding extra ws2 types.
2. **Major Incident SLA:** IT presumably wants a dedicated aggressive SLA row — confirm targets.
3. **Should type ever be required on TP-born create?** FS says optional; we currently force a
   default. Keeping the default (per-workspace) seems right; flag if anyone wants "no type".
4. **dueBy recompute on type change:** recompute silently, prompt the agent, or never touch a
   manually-set dueBy? Recommendation: recompute only when the existing dueBy came from SLA
   (tracked marker), with a toast.
