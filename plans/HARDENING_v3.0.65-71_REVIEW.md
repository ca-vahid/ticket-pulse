# Hardening & Modernization Plan — v3.0.65 → v3.0.71

**Scope:** the six releases landed in the last 48h on `cursor/workflow-enterprise`
(`e6ab396d`..`e89c62eb`): cross-origin merge, ticket Tasks, parent/child, per-agent
alerts, email-delivery health, enterprise Public API v2, OAuth2, durable webhooks 2.0.

**Method:** five parallel deep reviews (public-API/security, webhooks+alerts+email,
ticket relationships, frontend/UX, cross-cutting schema/tests/hygiene). Top findings
were re-verified directly against the code. Test suites were run:
**backend 801/802 pass, frontend 81/82 pass** — both failures are deterministic test
bugs, not product bugs.

Severity: **P0** = fix before this is called "enterprise" / before broad exposure ·
**P1** = should-fix this cycle · **P2** = hardening / polish.

---

## P0 — Blockers

### 1. `X-Forwarded-For` spoofing defeats the IP allowlist *and* every per-IP throttle
`backend/src/middleware/apiKeyAuth.js:19-22` — `clientIp()` reads the **first** XFF
entry, which is client-controlled behind Azure App Service (the platform *appends* the
real IP; an attacker *prepends* a fake one). This nullifies:
- the API-key `ipAllowlist` (a stolen `tp_live_` key + `X-Forwarded-For: <allowlisted-ip>` passes),
- the 300/min per-IP limit and the 30/min `/oauth/token` brute-force limiter (rotate fake IPs → unthrottled secret-guessing),
- and lets each fake IP insert a fresh `api_rate_windows` row (attacker-driven table growth).

**Fix (one line):** `trust proxy, 1` is already set in `app.js:35`, so use `req.ip`
(the right-most untrusted hop) instead of hand-parsing XFF. This also makes
`lastUsedIp`/audit rows trustworthy. **Everything else keyed on client IP is only as
strong as this fix**, so it lands first.

---

## P1 — Should fix this cycle

### API v2 / OAuth2

2. **Idempotency doesn't survive concurrent duplicates** — `apiIdempotency.js:30-58`.
   The replay row is written on response `finish`; two in-flight POSTs with the same
   `Idempotency-Key` both pass the `findUnique` and both create tickets (the loser's
   unique-violation is swallowed). This is the exact case idempotency exists for
   (aggressive client timeout + retry). Fix: INSERT a `pending` reservation *before*
   executing, catch the unique violation → 409 `idempotency_in_flight` (Stripe pattern).

3. **Idempotency is a silent no-op for OAuth callers and fails open on any DB error** —
   `apiIdempotency.js:31`, `apiKeyAuth.js:139`. OAuth principals have `apiKey.id = null`;
   `findUnique({ apiKeyId: null })` throws, and the `.catch(() => next())` swallows it →
   request runs with no idempotency and no error. Same catch turns any DB hiccup into
   fail-open. Fix: key the table on a credential bucket (`key:<id>` / `oauth:<clientId>`)
   and don't blanket-swallow.

4. **Key/client rotation resurrects revoked credentials** — `apiKeyService.js:134-137`,
   `oauthClientService.js:117-119`. `rotate()` sets `revokedAt: null, isEnabled: true`,
   so rotating a *revoked* (compromised) credential silently re-arms it. Also the plan
   promised a 24–48h grace window and `rotatedFromId` exists in schema but is never
   written (dead column). Fix: refuse to rotate revoked credentials; either implement
   grace (dual-secret) or delete the promise from the docs.

5. **`tp_test_` keys have full production read/write** — `apiKeyService.js:38-42`,
   `apiKeyAuth.js:141`. `req.apiMode` is set but nothing consumes it, yet the docs page
   (`apiV1.openapi.js:221`) tells integrators to "use `tp_test_…` while building." An
   integrator will run destructive experiments against live tickets and email real
   requesters believing they're sandboxed. Fix now: reject writes on `mode==='test'`
   keys (or restrict to TP-born test records) **or** remove the "safe to experiment"
   language until data partitioning ships.

6. **Login/token endpoints still unthrottled** — plan §5.2 promised throttling
   `/api/auth/*`; it isn't wired (the `rateLimit: true` at `auth.routes.js:35` is
   jwks-rsa's JWKS throttle). The durable limiter exists — wire it per-IP (after #1).

7. **Webhook secret rotation & at-rest encryption shipped as schema only** —
   `schema.prisma:380` keeps `WebhookSubscription.secret` plaintext; migration added
   `secret_previous`/`secret_rotated_at` but **zero** code references them and
   `sendHttp` signs with the current secret only. "Dual active secrets" exists only in
   the commit message. Fix: sign with both secrets during rotation (Standard Webhooks
   supports space-separated signatures, ~3 lines) and encrypt the secret at rest, or
   scope the claim down in the docs.

### Webhooks / Alerts / Email health

8. **SSRF via redirect on the webhook delivery path** — `webhookDispatchService.js:100`.
   `sendHttp` uses `fetch` with default `redirect: 'follow'` and never re-validates the
   URL; a registered `https://partner/hook` that 302s to `http://169.254.169.254/…`
   gets the signed payload POSTed internally. The sibling `executeWebhookNode` already
   sets `redirect: 'error'` — this one missed it. Fix: `redirect: 'error'` + resolve-
   then-check the target IP (the current hostname-prefix blocklist misses decimal/hex/
   IPv6/DNS-rebind). Admin-only creation mitigates but doesn't close it.

9. **Agent-alert dedup permanently swallows repeat escalations** —
   `agentAlertService.js:214-217` + migration unique `(subscription_id, ticket_id, trigger)`,
   rows never deleted. Medium→High fires once; the later High→**Urgent** on the same
   ticket inserts nothing and is dropped — defeating the `allowUrgent` quiet-hours bypass
   that was built for exactly this. Fix: scope dedup to a window (e.g. unique only among
   `sentAt IS NULL`, or dedup on a short time bucket), coupled with #11's pruning.

10. **Category-scoped "new ticket" alerts never fire for FS-born tickets** —
    `syncService.js:1459`. `evaluate('created')` runs at sync upsert, *before* AI
    populates `internalCategoryId`, so a category-scoped subscription (the headline use
    case) matches nothing; the later categorization fires `'recategorized'`, which
    defaults **off**. Net: category alerts largely never fire on the FS route (all of
    prod except ws2). Fix: re-evaluate `created` after categorization, or treat the
    first categorization of a new ticket as a `created` trigger.

11. **Three new event tables grow unboundedly (the v3.0.23 leak class)** —
    `agent_alert_events`, `notification_channel_health_events`, and (partially)
    per-email health rows have no pruning. `apiMaintenanceService.sweep()` already runs
    every 5 min and prunes the API tables — add 30-day sweeps for these three (a few
    lines each). Reads are already windowed/indexed, so this is pure storage safety.
    Note the ordering dependency with #9: today the retained alert rows *are* the dedup
    memory, so the dedup rework and the prune land together.

12. **Alerts are at-most-once; total delivery failure still consumes the events** —
    `agentAlertService.js:290-291`. `_flushSubscription` stamps `sentAt` even when every
    channel returned `{sent:false}` (SendGrid down, phone unverified). Combined with the
    permanent dedup (#9), an alert lost to a transient outage can never fire again. The
    webhook path in the same release got durability; this one got none. Fix: only stamp
    `sentAt` when ≥1 channel succeeded; retry the rest with a capped backoff.

13. **Twilio/SMS failures invisible to the email-health system** —
    `agentAlertService.js:359-370`. SMS failures go into per-event JSON only, never
    `recordFailure({ channel: 'sms' })`. The very incident this feature answers (a
    provider silently dropping sends) can recur on the Twilio path with zero telemetry.
    The `channel` column already exists — wire the SMS path into it.

### Ticket relationships

14. **Single-merge endpoint has no survivor gating** —
    `ticketMergeService.js:31-38`, route `tickets.routes.js:557`. The "survivor must be
    TP-born & Open/Pending" rule lives only in `mergeMany()` and the modal's disabled
    radio, but `POST /:id/merge` is still wired to the Linked-tickets card and accepts
    FS-born or Closed targets. Merging into an FS-born target copies the conversation
    into a TP shadow FreshService never sees. Fix: move the gate into `merge()` itself.

15. **`parent_of` invariants bypassable via the generic links API — and the UI exposes
    it** — `ticketLinkService.js:6,40-58`, route `tickets.routes.js:960`. `LINK_KINDS`
    still includes `parent_of`, `link()` runs none of `setParent()`'s checks (single
    parent, no cycles), and `POST /:id/links` has **no agent-role gate** while
    `POST /:id/parent` blocks agents. Enables data-level cycles, multiple parents, and
    an agent creating parent links they're explicitly barred from. Fix: drop `parent_of`
    from `LINK_KINDS`/the generic route (route it through `setParent`), or apply the same
    guards + role gate there.

16. **Merge doesn't reconcile the source's tasks, children, or pending approvals** —
    `ticketMergeService.js:26-161` (merge predates Tasks/family by one commit). After a
    merge: open tasks stay on the closed husk, children still point at the husk, and
    pending approvals keep live 30-day magic links (an approver can approve a merged-away
    ticket). Fix: move/close open tasks, re-parent children to the survivor, cancel
    pending approvals — all inside the merge transaction.

### Cross-cutting

17. **`OAuthClient` onDelete drift** — `schema.prisma:193` (no `onDelete` → Prisma
    default **Restrict**) vs migration `20260726…:23` (`ON DELETE CASCADE`). Next
    `prisma migrate dev` will generate a surprise migration, or code assuming Restrict is
    wrong because the DB cascades. Fix: add `onDelete: Cascade` to the schema relation.

18. **Two deterministic test failures (both from v3.0.69)** —
    - `notificationWorkflowDefinition.test.js:331` asserts against the **audit-sanitized**
      step output (`[redacted-email]`) instead of the live send path (`state.recipients.cc`,
      which is correct). Fix the test.
    - `EmailHealthCard.test.jsx:57` races: the card shows "No recent sends" while
      `loading` is still true, so `waitFor` resolves before the mock settles. Move the
      assertion inside `waitFor`; also show a neutral "Checking…" badge while loading
      rather than claiming "No recent sends" before it knows.

### Frontend / UX

19. **One-click, no-confirm destruction of live credentials** —
    `ApiKeysPanel.jsx:335/225/131/287/185`. Delete/rotate sit ~4px from Enable/Disable;
    a mis-click silently invalidates a production integration whose secret is shown once.
    Fix: two-step inline confirm (or a small dialog) for delete + rotate, at least for
    `live` keys and enabled OAuth clients.

20. **Silent load-failure renders as misleading empty state** —
    `ApiKeysPanel.jsx:275/74/176` (`.catch(() => {})`) and `TicketFamilyCard.jsx:27`. A
    401/500 on a credentials page renders "No API keys yet." — an admin may conclude
    keys were wiped. Fix: distinguish error from empty (EmailHealthCard already does the
    loading/error/empty triad correctly — copy it).

21. **MergeTicketsModal missing Escape-close + initial focus** —
    `MergeTicketsModal.jsx:153-172`. Every sibling modal binds Escape and this one
    doesn't; focus also never enters the dialog on open. Fix: copy the Escape effect from
    `RequestApprovalModal` and focus the search input on mount. (Full focus-trap is a
    repo-wide follow-up.)

---

## P2 — Hardening & polish (grouped; fix opportunistically)

**API robustness**
- `Link: rel="next"` pagination header drops active filters → page 2 unfiltered (`apiV1.routes.js:151`).
- Invalid cursor silently restarts from top instead of 400; `sort`/`dir` silently ignored in cursor mode (`ticketService.js:608`).
- `PATCH /tickets/:id` is 3 non-transactional calls → partial updates on mid-sequence failure; no `ETag`/`If-Match` despite plan §5.4 (`apiV1.routes.js:180`).
- Task PATCH/DELETE don't verify the task belongs to `:id` in the URL (`apiV1.routes.js:258`; same class in web route `tickets.routes.js:1047`).
- NaN path params → Prisma throws → 500 instead of 400/404 on every `:id` route.
- 401s lack `WWW-Authenticate`; `/oauth/token` Basic parse skips URL-decode (`apiV1.routes.js:103`).
- Rate limiter, idempotency, and request-logging all **fail open** together — a degraded DB removes every abuse control at once; fail closed for `/oauth/token` at least (`apiRateLimitService.js:28`).
- Unauthenticated `/api/v1` probes still insert an `api_request_log` row before any throttle (`apiKeyAuth.js:62`); add an un-indexed-sweep-friendly leading-`createdAt` index and/or skip logging 401/404-unauth.
- Advertised-but-dead scopes (`timeentries:*`, `webhooks:*`) gate no endpoint — stop granting them until the endpoints exist (`API_KEY_SCOPES`).
- Set explicit `API_OAUTH_SECRET` in prod (currently falls back to a `SESSION_SECRET` derivative — rotating the session secret silently invalidates all API tokens) (`oauthClientService.js:17`).
- `ipAllowed` is IPv4-only — a v6 client with any allowlist is hard-locked out (`apiKeyAuth.js:24`).
- CORS: `/api/v1` inherits the app's single-origin credentialed CORS; document "server-to-server only" or mount `cors({origin:'*'})` bearer-only on the v1 router (`app.js:44`).

**Webhooks / alerts / email**
- Webhook secret generated as base64url but consumers decode as standard base64 → signature fails in strict (e.g. Python) libs; generate with `toString('base64')` (`tickets.routes.js:767`).
- No cross-instance row-claim on the outbox (`FOR UPDATE SKIP LOCKED`) → guaranteed double-delivery if the app ever scales out; also lossy `failureCount` RMW (`webhookDispatchService.js:166`).
- Disabled subscriptions keep getting hammered by already-pending deliveries; `redeliver()` requeues into disabled subs (`webhookDispatchService.js:143,207`).
- Sequential delivery = head-of-line blocking; one slow endpoint delays all webhooks (up to 5 min/tick) (`webhookDispatchService.js:176`).
- Auto-disable is "~160 failed attempts," not "20 failures" as the docstring/UI imply (`webhookDispatchService.js:15,32`).
- `agent_alert_events` flush `groupBy(where sentAt:null)` has no `sent_at`-leading index → table scan every tick; add a partial index (`agentAlertService.js:245`).
- Quiet-hours hold busy-loops the full query set every 10s per held subscription until morning (`agentAlertService.js:251`).
- Urgent bypass ships the whole held batch (non-urgent included); quiet-hours TZ falls back to `America/Los_Angeles` instead of workspace `defaultTimezone` (`agentAlertService.js:280,304`).
- Manual (non-AI) recategorization never fires the `recategorized` trigger (`ticketService.js:1850`).
- One bad recipient (`invalid_recipient`, a per-recipient 400) flips the global admin banner to "degraded"; `getStatus` mixes providers/workspaces into one stream (`emailHealthService.js:233`).
- Raw (pre-sanitization) provider error logged — can leak the recipient address that the DB row redacts (`transactionalEmailService.js:48`).

**Ticket relationships**
- FS-born task edit/delete swallow FS failures then self-revert on next sync → "Done" silently reverts to "Open" (`ticketTaskService.js:125,164`).
- Failed assignee email still stamps `notifiedAt` → never retried (`ticketTaskService.js:254`).
- Task routes: no native-ticketing gate on create (unlike `/notes`); delete-by-any-agent ungated (`tickets.routes.js:1047`).
- `setParent` race (findFirst→delete→upsert, no txn/partial-unique) can create two parents; add partial unique index on `(relatedTicketId, kind='parent_of')` (`ticketLinkService.js:140`).
- Chained-merge black hole + 3-cycle: circular guard only checks the direct pair; block targets carrying a `merged_into` link (`ticketMergeService.js:40`).
- FS-close failure during merge is invisible (`merged:true` returned); surface `sourceClosed:false` per source (`ticketMergeService.js:143`).
- Any converse-capable actor (incl. agents) can delete `parent_of`/`merged_into` links, erasing the audit pointer and re-enabling reverse merges (`tickets.routes.js:978`).
- Tasks-tab open-count badge shows 0 until the tab is visited (`TicketDetail.jsx:2325`).
- Stale "TP-born only" copy in `TicketLinksCard` merge UI — both now work for FS-born sources (`TicketOpsCards.jsx`).
- Tasks tab: "description" field actually writes `title`; the real `description` column is uneditable in the UI; `notifyAgent` inert on FS-born (`TicketTasksTab.jsx:154,215`).

**Frontend / a11y**
- `EmailHealthBanner` uses `animate-slide-in-right` on a bottom-left toast (slides the wrong way) and neither `animate-slide-in-right` nor `animate-fadeIn` are in the `prefers-reduced-motion` block (`index.css:567`).
- Missing `.tp-focus-ring` on the EmailHealthCard Refresh and EmailHealthBanner Dismiss buttons (dismiss sits on a saturated red surface).
- Raw `bg-blue-600`/hardcoded primary in `ApiKeysPanel`, `MyCompetencies` sub-tabs, `TicketFamilyCard.jsx:142` where `bg-primary text-primary-foreground` exists (used correctly two files over).
- Sub-AA `text-slate-400` on load-bearing info (expiry dates, failure counts, "cannot be undone") — bump to `slate-500/600` (`ApiKeysPanel.jsx:124,329`, `MergeTicketsModal.jsx:255`).
- MyCompetencies notification sub-tabs lack `aria-pressed`/tab semantics (`MyCompetencies.jsx:1081`).
- AgentAlertsPanel: quiet-hours PUT on every keystroke with no debounce/rollback; Save not gated on ≥1 trigger + ≥1 channel; no stale-response guard on workspace switch; delete has no confirm (`AgentAlertsPanel.jsx:58,84`).
- `DeliveryLog` `setTimeout(load,300)` not cleared on unmount (`ApiKeysPanel.jsx:37`).
- `EmailHealthBanner` becomes undismissable if `status:'down'` with null `lastFailureAt` (`EmailHealthBanner.jsx:41`).
- Agent-role write gate briefly true during load (`meta===null` → `undefined!=='agent'`) (`TicketDetail.jsx:2676`).

**Schema / hygiene**
- `ticket_tasks.workspace_id` and `ApiKey.rotatedFromId` have no FK (consistency nit).
- Prisma pinned `^5.19` while 6 is current — no action for these features; note for the next platform bump.

---

## Test coverage to add (highest-leverage gaps)

The features with the thinnest coverage are also the highest-blast-radius:
- **`mergeMany`** — the *only* place the TP-born-survivor rule currently lives; plus merge×tasks/family/approvals interaction.
- **`requireApiKey` end-to-end** — expired/revoked key → 401, insufficient scope → 403 problem+json, allowlist deny, 429 + `Retry-After`.
- **`withIdempotency` middleware** — replay, mismatched-body 422, and the OAuth null-keyId path (a test would have caught #3).
- **`/oauth/token` route** — Basic auth, bad grant_type, revoked client.
- **Agent-alert flush** — coalescing timing, sent-marking on total failure (#12), repeat-raise suppression (#9).
- **Component smoke tests** — `MergeTicketsModal` (the `isMergeable`/`canMerge` origin rules), `AgentAlertsPanel`, `ApiKeysPanel` (show-once secret + rotate).
- **`/links` `parent_of` bypass** and `setParent` multi-hop cycle.

---

## Repo hygiene (proposed; nothing deleted here)

Untracked sprawl includes `backups/` (~270 MB, contains a **prod DB dump** that must
never enter git history), 36 `backend/scripts/*.mjs`, and ~47 MB of qa/docs binaries.

1. **Gitignore:** `backups/`, `*.dump`, `reports/`, `scratchpad/`, `qa/*.docx`,
   `qa/*.pdf`, `docs/QA_Test_Plan_*.pdf`, `docs/*.docx`, `backend/scripts/tmp-*.mjs`,
   `backend/scripts/probe-*.mjs`, `backend/scripts/qa-0*.mjs`.
2. **Commit as durable tooling:** `backfill-ticket-types`, `seed-ticket-types`,
   `seed-dev-groups`, `list-agents`, `export-agent-report`, `fetch-agent-photo`,
   `load-ar-taxonomy`, `derive-ar-taxonomy`, `verify-t3-routing`, plus `plans/*.md`.
3. **Archive** completed phase/one-off scripts to `backend/scripts/archive/` (gitignored).

---

## Suggested execution order

1. **#1 (XFF)** — one line, unblocks every IP-based control.
2. **The two test fixes (#18)** — get CI green so subsequent work is trustworthy.
3. **Merge & links integrity (#14, #15, #16)** — data-corruption class; the ungated
   endpoints are live in the UI right now.
4. **Alert correctness + unbounded tables (#9, #11, #12, #10)** — land the dedup rework
   and the retention sweeps together; add the SMS telemetry (#13).
5. **API idempotency + rotation + test-mode (#2, #3, #4, #5)** and **webhook SSRF (#8)**.
6. **Auth throttling (#6)** and **webhook secret rotation/encryption (#7)**.
7. **Frontend safety (#19, #20, #21)** — credential-delete confirms and honest error states.
8. **P2 sweep** opportunistically, then the test-coverage backfill and repo hygiene.

Nothing here changes the architecture — the principal abstraction, durable outbox,
problem+json layer, origin-aware task write-back, and storm-coalescing design all
reviewed as the right shape. This is tightening the edges on a sound foundation.
