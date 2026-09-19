# Simorgh × Ticket Pulse — SOC relations (Ticket Pulse side)

**Source:** "Ticket Pulse relations for SOC operations", Vahid Haeri, 19 Sep 2026 (artifact `TFEzrW9syKMS1tfYn6PrJo`; companion `Docs/TICKET_PULSE_SOC_STRUCTURE_PROPOSAL.md` in the Simorgh repo).
**Owner here:** Claude (full stack). **Status legend:** ☐ todo · ◐ in progress · ☑ shipped (version).

Simorgh knows which incidents belong to one story. Ticket Pulse has parent/child, merge, split, tasks and links. This plan is the Ticket Pulse half of connecting them: the eight asks in §4 of the proposal, in the order that unblocks Simorgh's phases T1 → T3.

---

## 1. Review of the proposal

The feature table was checked against `origin/main` on 19 Sep 2026. It is accurate, with these corrections and additions.

| # | Finding | Effect on the plan |
|---|---|---|
| R1 | `resolutionReason`, `resolutionNote`, `resolvedByKind` **are already** on `GET /api/v1/tickets/{id}`. TP-1504 showed none because nothing set them (see R2). | Ask 6 shrinks to "where was this merged". |
| R2 | **Ask 7 root cause found.** TP-1504 was closed on the *FreshService fallback copy* by an IT agent (after a private note there at 12:58 PT). `syncService.reconcileSingleTicket` mirrored the close back at 13:08 with a direct `prisma.ticket.update` + a history row — **no lifecycle event**, so no `ticket.status_changed` webhook, no workflow run, no `resolvedByKind`. Mirror-driven *assignments* do emit; mirror-driven *closes* do not. A defect on our side. | Fixed first (A1). |
| R3 | The URL `:id` on every v1 route already accepts a display ref (`TP-1504`, `SR-242218`). Only **body** ids (`targetTicketId`, `parentTicketId`, `childTicketId`) are numeric-only. | Ask 2's "display reference as merge target" = accept refs in bodies (A3). |
| R4 | Merge already writes a `merged_into` link and `merged_into` / `merged_from` history rows on both tickets. It is just not readable on v1. | `mergedInto` on the read shape (A3). |
| R5 | **Tasks on TP-born tickets are pushed to FreshService, but a task completed on the FreshService copy is never pulled back** (`_syncFromFs` runs for FS-born tickets only). An agent who ticks the task in FreshService leaves Simorgh waiting for ever. Same habit that produced R2 and TP-1285's duplicate (watch item, 18 Sep). | B5: pull task status back for TP-born mirrors. Until then Simorgh should treat "parent ticket closed" as closing its open tasks. |
| R6 | Simorgh's clients (#10 IT, #9 sandbox ws7) already hold `agents:read` and `groups:read`, so it can resolve an assignee id. Neither has `tasks:*`. Tokens are stateless JWTs carrying scopes — **Simorgh must fetch a new token after the grant.** | A4. |
| R7 | Sandbox webhook subscription **#4 is disabled** today. "Sandbox first" needs it re-enabled. | Vahid / A4. |
| R8 | The guard-rail "Simorgh only structures tickets it created" is enforced only in Simorgh. Merge closes a ticket; a bug there closes a human's ticket. | B6 (optional, recommended): a per-client `structureOwnTicketsOnly` flag enforced in Ticket Pulse. |
| R9 | `POST …/tasks` is idempotent only inside the idempotency-key window. A pending action retried a day later makes a second task. | B4: optional `externalRef` on tasks, unique per ticket → create-or-return. |
| R10 | "P3 = next business day" needs a calendar. Ticket Pulse has the workspace business-hours calendar; Simorgh does not. | C2: `duePreset` computed server-side from the workspace calendar. |
| R11 | Group-assigned tasks (ask 5) need a schema change **and a product decision**: who gets the assignment e-mail and the reminder — every member, or nobody until someone takes it? | C1, blocked on the decision. |
| R12 | Roll-up (ask 8) is a product rule that would bind humans too. | Not built. Simorgh enforces it on its side for T1; revisit with data. |
| R13 | `task.updated` can storm (Simorgh edits descriptions). | B2 coalesces like `ticket.fields_updated`: one delivery per task per 60 s, `task.completed` always immediate. |

**Decisions (Vahid, 19 Sep 2026):** sandbox skipped — test in IT on Simorgh's own tickets, merge/split held until the guard (B6) is live; group tasks dropped for "unassigned task belongs to the ticket owner" (B7); guard: yes (B6); roll-up: block, never auto-close, ready-to-close marker + owner alert (B8). Reply sent to Simorgh: artifact `39ff97d1-5a03-42f8-8aaf-d5b0791ca53d`.

---

## 2. Phases

### Phase A — unblocks Simorgh T1 (no schema change)
| | Task | Ask |
|---|---|---|
| ☑ A1 (3.9.50) | Mirror-back close emits the lifecycle event (`ticket.status_changed`, workflows, SSE) and stamps `resolvedByKind = 'freshservice'`. Test pins "a close that came from FreshService is delivered". | 7, 6 |
| ☑ A2 (3.9.50) | History rows for every relation change: `parent_set`, `parent_removed`, `linked`, `unlinked`, `marked_duplicate`, `unmarked_duplicate` — on **both** tickets, with actor kind. | 4 |
| ☑ A3 (3.9.50) | Read shape: `mergedInto {id, ref}`, `parent {id, ref}`, `childCount` on `GET /tickets/{id}`. Bodies accept a display ref wherever they take a ticket id (`target`, `parent`). A merged ticket's GET keeps working (no redirect — the reference resolves and says where it went). | 6, 2 |
| ◐ A4 | Grant `tasks:read`, `tasks:write` to clients #10 (IT) and #9 (sandbox) — **done 19 Sep 2026**. `tickets:write` covers merge/split/parent. **Open:** re-enable sandbox subscription #4 (Vahid). | 1 |
| ☑ A5 (3.9.50) | Integration guide: relations section + the **activity type vocabulary**. OpenAPI updated (`apiV1OpenApiSpec.test.js` must stay green). | 4 |

### Phase B — unblocks Simorgh T2
| | Task | Ask |
|---|---|---|
| ☑ B1 (3.9.51) | v1 `GET/POST/DELETE /tickets/{id}/links` (`related_to`, `duplicate_of`), `POST /tickets/{id}/children`, `POST /tickets/{id}/merge-many` (≤ 20 sources, sequential, per-source result, idempotent). New scopes not needed: `tickets:write`. | 2 |
| ☐ B2 | Webhooks: `ticket.linked`, `ticket.parent_changed`, `ticket.merged`, `ticket.split`, `task.created`, `task.updated` (coalesced), `task.completed`. Task payload: ticket `{id, ref}`, task `{id, title, status, assignee{id,name,email}, dueAt, externalRef}`, actor. | 3 |
| ☐ B3 | Subscription #5 / #4 opt in to the new events (Settings UI lists them automatically from `WEBHOOK_EVENTS`). | 3 |
| ☑ B4 (3.9.51) | Task `externalRef` (migration, additive): create-or-return per ticket. | R9 |
| ☐ B5 | R5 corrected: `_syncMirroredStatusFromFs` already pulls task status back when the tasks are LISTED. Remaining: run it in the mirror reconciliation sweep too, so a completion is seen without a list call. | R5 |
| ☑ B6 (3.9.51) | **First in B (Vahid: yes).** Per-client `structureOwnTicketsOnly`: merge / split / parent / links refused (403 `not_client_ticket`) unless the ticket was created by that client. | R8 |
| ☑ B7 (3.9.51) | **Unassigned task = the ticket owner's** (Vahid, 19 Sep): the owner is alerted on creation, gets the due reminder, and a new owner is told about open tasks when the ticket changes hands. | 5 |
| ☑ B8 (3.9.51) | **Roll-up (Vahid, 19 Sep):** a parent cannot close while a child is open (`409 open_children`, people and API alike); never auto-closed; when the last child closes the parent gets a quiet *ready to close* marker, its owner is alerted, and `ticket.ready_to_close` is emitted. | 8 |

### Phase C — unblocks Simorgh T3
| | Task | Ask |
|---|---|---|
| ✕ C1 | Group-assigned tasks — **dropped (Vahid, 19 Sep)**: a task belongs to a ticket, and the ticket has an owner. Replaced by B7. | 5 |
| ☐ C2 | `duePreset: 'p1' \| 'p2' \| 'p3'` on task create, from the workspace business calendar (1 h, 4 h, next business day by default; configurable in Ticket Ops). | 5 |
| → C3 | Roll-up rule — **decided (Vahid, 19 Sep)**, moved to B8. | 8 |

---

## 3. Cross-cutting
- Every relation write goes through `ticketLinkService` / `ticketMergeService` / `ticketSplitService`; the v1 routes stay thin. History + webhook emission live in the services so the in-app UI gets them too.
- Problem codes for new refusals are registered in the v1 problem registry and the OpenAPI spec.
- Sandbox (ws7) first with Simorgh's acceptance script, then IT. Ticket Pulse never touches ws6/ws7 data beyond the client scope grant and subscription #4, both asked for in the proposal.
- Migrations are additive and applied to prod by hand right after merge (memory: prod-migrations-manual).

## 4. Deliverables
- Releases: A = one backend release; B = two (endpoints+webhooks, then externalRef+task pull-back+guard); C after the decisions.
- `plans/SIMORGH_INTEGRATION_GUIDE.md` updated each phase; a short "what changed for Simorgh" note per release for Vahid to forward.
