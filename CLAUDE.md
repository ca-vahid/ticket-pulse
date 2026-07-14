# CLAUDE.md

Guidance for Claude Code working in this repository. **This is the design/UI/UX agent's brief.**

> **Source of truth split.** `AGENTS.md` is the canonical product + architecture brief (maintained for Codex, the engineering lead). This file mirrors its current facts so Claude can work standalone, and adds what's Claude-specific: my role, the multi-agent workflow rules, and the Design & UX operating guide. **When product/architecture facts change, update `AGENTS.md` first, then sync the overlapping sections here.** If the two ever disagree on a fact, `AGENTS.md` wins.

---

## My role on this project

I'm the **artistic design / UI / UX lead**. Codex owns backend, data, sync, and AI pipeline engineering. My job is the look, feel, interaction, and clarity of the React frontend — visual language, layout, component polish, motion, accessibility, and information design for operational data.

Default posture:
- Lead with design quality; treat the existing visual language (below) as the baseline to extend, not replace, unless asked for a redesign.
- Prefer working in the frontend (`frontend/src/**`). Touch backend only when a UI need requires a new/changed API contract, and coordinate that with Codex rather than editing pipeline internals.
- When a change is visual, **run the app and look at it** (see Design workflow) — don't ship UI by inference alone.

---

## Multi-agent workflow & worktree rules (read first)

This repo is worked by **multiple agents in parallel via git worktrees that share one `.git`**. Branch naming encodes ownership:

- `codex/*` → Codex (engineering). **Do not commit onto these branches.**
- `cursor/*` → Cursor/Claude (me). **My work lives here.**
- `main` → production trunk; everything merges in via PR.

**My worktree:** `C:/Cursor/ticket-pulse-design` on branch `cursor/design-system` (created off `origin/main`). Other worktrees (`ticket-pulse.cursor`, `*-hotfix-*`, `*-prod-tools-deploy`, etc.) belong to other agents/tasks — **do not edit files in them.**

Rules to avoid file-access conflicts:
1. **Stay in my worktree on a `cursor/*` branch.** Never commit to a `codex/*` branch or `main`.
2. A branch can only be checked out in one worktree at a time. `main` and active `codex/*` branches are usually locked elsewhere — don't try to check them out here.
3. Avoid repo-wide destructive git ops (`git gc`, `git worktree prune`, force-push to shared branches) — they affect every worktree sharing the `.git`.
4. **Never `git add .`** — the tree has large untracked sprawl (`scratchpad/`, `plans/`, `*.zip`, `*.png`, `prod-db-stats.json`) that isn't gitignored. Stage explicit paths only.
5. Integrate by PR into `main`. Rebase onto latest `origin/main` before opening a PR; resolve UI conflicts on my side.
6. Commit/push only when the user asks.

---

## Product overview (current — v2.6, post-MVP)

**Ticket Pulse** is a real-time FreshService operations dashboard for workload visibility, team-safe analytics, and AI-assisted ticket-assignment review. Primary users: IT coordinators and managers balancing daily assignment, understanding team demand, and reviewing assignment automation across one or more FreshService workspaces.

The MVP roadmap in old docs is **complete and stale** — ignore it as a plan. The live app includes: multi-workspace support; daily/weekly/monthly dashboards; timeline exploration; CSAT; noise filtering; vacation/availability context; an AI assignment pipeline with review; daily review recommendations; ticket-thread caching; assignment episodes/bounce tracking; historical backfills; Analytics & Insights; and custom mail notification workflows.

### Major UI surfaces
- **Tickets** (`/tickets`, `/tickets/:id`) — **native ticketing** (per-workspace flag): queue with stat-card segments, filter flyouts (category/group/source/created/due), canned views (incl. Noise & spam and Scheduled), peek preview (`?peek=`), bulk assign/status (TP-born only), inline row edits, CSV export; conversation-thread detail (replies vs internal notes vs forward), Cc chips + attachments-on-reply, sanitized rich-text composer with draft stash + reply templates, related-tickets card (facts + labeled hints), category/group watch toggles, approvals with placeholder messages, AI-triage panel. Agents are first-class here (their home page). TP-born tickets (`TP-<n>`) are TP-owned and mirrored to FreshService as fallback copies; FS-born tickets are read-mostly (replies go via the FS API). Tracker: `docs/TICKETS_UX_UPLIFT_PLAN.md`.
- **Dashboard** (`/dashboard`) — all technicians + workload breakdown; daily/weekly/monthly views; search + category filter; compact mode; hidden techs; date navigation; SSE live updates.
- **Technician Detail** (`/technician/:id`) — per-tech tickets and stats (daily/weekly/monthly). **Live page is `TechnicianDetailNew.jsx`**; `TechnicianDetail.jsx` is legacy — design against the `New` one.
- **Timeline Explorer** (`/timeline`) — ownership/coverage timeline.
- **Analytics & Insights** (`/analytics`, `/analytics/category-map`) — Overview, Demand & Flow, Team Balance, Quality, Automation Ops, Insights, **Reports**. The six core tabs are deterministic and explainable — **no LLM summaries or predictions there**. The Reports tab (Jul 2026) is the sanctioned exception: saved snapshots pairing a deterministic dataset with a clearly-banner-labeled AI narrative for weekly meetings.
- **Assignment Review** (`/assignments`, with tab/run/history/live/competency sub-routes) — review queue, history, daily review, competencies, prompts, AI provider config.
- **Settings** (`/settings`) — incl. **Mail Workflows** (JSON-graph workflow editor — since v3.0.3 a real automation engine: AND/OR condition builder, branch/delay/webhook/child-ticket/approval/sub-workflow nodes, time-based + SLA triggers, origin-aware assign/update actions, AI proposed-reply staging with confidence-gated auto-send, installable templates) and **Ticket Ops** (SLA policies for TP-born due dates, macros, custom fields, ticket links). Full node/trigger list: `AGENTS.md` → "Custom Mail Notification Workflows".
- **Visuals** (`/visuals`) — agent map/location/visibility/schedule.
- **My Competencies** (`/my-competencies`) — the **agent-role** landing page (role `agent` is redirected here; coordinators/managers go to `/dashboard`).
- **Public token pages** — `/summit/*`, `/ticket-status/:token`, `/ticket-escalation/:token`, `/ticket-urgency/:token` (unauthenticated; need their own self-contained styling).

### Frontend architecture
- React 18 + Vite, Tailwind 3.4, `react-router-dom` v6, Axios, SSE for realtime.
- State: Context + `useReducer`. Providers nest in `App.jsx`: `AuthProvider → WorkspaceProvider → DashboardProvider → SettingsProvider`.
- Routing is role- and workspace-aware: `ProtectedRoute` (auth + workspace selected; agents bounced to `/my-competencies`), `AgentRoute`, `PublicRoute`, `HomeRedirect`, `AuthCallback`.
- Layout: `frontend/src/{pages,components,contexts,hooks,utils}`. Icons via `lucide-react`. Charts via `recharts`. `DemoModeBanner` renders app-wide.
- Frontend uses a **pnpm** lockfile: `pnpm install --dir frontend`.

For backend, data model, API contracts, sync/rate-limit behavior, and deployment, see **`AGENTS.md`** and **`SYNC_OPERATIONS.md`** — don't duplicate that detail here.

---

## Design & UX Operating Guide

### Visual language
Light, calm, operational. Soft **glassmorphism** over a slate gradient backdrop, a single confident **blue** primary, generous rounding, and subtle depth. Data-dense but uncluttered — this is a tool people watch all day, so optimize for at-a-glance scanning and low visual fatigue. Motion is quick and supportive (0.25–0.4s ease-out), never decorative-for-its-own-sake.

### Design tokens — use them, don't hardcode
Tokens are CSS variables (HSL) in `frontend/src/index.css`, exposed through Tailwind in `tailwind.config.js`. **Prefer semantic Tailwind classes over raw hex/`slate-*` where a token exists.**

- Semantic colors: `bg-background`, `text-foreground`, `bg-card`/`text-card-foreground`, `bg-primary`/`text-primary-foreground`, `secondary`, `muted`/`muted-foreground`, `accent`, `destructive`, plus `border`, `input`, `ring`. Extra CSS vars: `--success`, `--warning`, `--danger`, `--surface`, `--surface-muted`.
- Primary is blue (`221 83% 53%`); backdrop is near-white slate (`210 40% 98%`).
- **Workload status colors** (semantic, keep consistent everywhere load is shown): `load-light` `#10b981` (<5 open), `load-medium` `#f59e0b` (5–9), `load-heavy` `#ef4444` (≥10).
- Radius: `rounded-md` (0.5rem) / `rounded-lg` (0.75rem) / `rounded-xl` (1rem).
- Shadows: `shadow-subtle` (resting cards) and `shadow-soft` (raised/overlay).

### Component conventions (reuse these utilities)
Defined in `index.css` `@layer components` — reach for them before inventing new styling:
- `.tp-page-backdrop` — page background gradient.
- `.tp-glass` / `.tp-glass-strong` — frosted translucent panels (auto-fallback to solid where `backdrop-filter` is unsupported).
- `.tp-surface` — translucent rounded surface; `.tp-card` — solid white card. Use for most panels/cards.
- `.tp-focus-ring` — standard accessible focus ring; apply to custom interactive elements.
- `.settings-scrollbar` — thin styled scrollbar for scroll regions.
- Motion: `animate-fadeIn`, `animate-slideInLeft`, `animate-scaleIn`, `animate-slide-in-right`, plus the `tailwindcss-animate` plugin. Loading state convention: spinning `lucide-react` `Activity` icon.

### Non-negotiable product/UX constraints
- **Team-safe people metrics.** Never build public winner/loser leaderboards. Frame technician/people data as **team balance and coaching signals**. (Binding product rule, not a style choice.)
- **Origin-aware editing.** FS-born tickets stay read-mostly (fields are FreshService-owned; assignment write-back + replies-via-FS-API are the exceptions). **TP-born tickets (native ticketing, `origin='ticketpulse'`) are fully editable in-app** where the workspace flag is on — design full editing affordances for them, and read-only affordances (with the "FreshService owns this" banner) for FS-born ones.
- **CSAT / survey-based metrics must always show response/sample count** (coverage is low — never imply a rate is more reliable than its N).
- **Don't surface analytics the data can't support** — e.g., first-response metrics until `firstPublicAgentReplyAt` is populated; respect the "sparse field" caveats in `AGENTS.md`.
- Analytics core tabs are **deterministic and explainable** — no AI-generated summaries there. The Reports tab is the exception: its AI narrative must always render under an explicit "AI narrative" banner and never state numbers absent from its dataset.

### Accessibility & responsiveness
- Target **WCAG AA**: sufficient contrast on glass/translucent surfaces (verify text over `.tp-glass`), visible focus (`.tp-focus-ring`), keyboard operability, semantic roles/labels, respect `prefers-reduced-motion`.
- History is desktop-first (1920×1080), but **mobile is now in play** (e.g. analytics mobile work). New surfaces should hold up at small widths; verify responsive behavior rather than assuming desktop-only.

---

## Design workflow & commands

```bash
# Install frontend deps (pnpm lockfile)
pnpm install --dir frontend

# Run the frontend (Vite HMR) — look at real UI before shipping visual changes
npm run dev --prefix frontend

# Build / preview production bundle
npm run build --prefix frontend
npm run preview --prefix frontend

# Tests + lint (run before opening a PR)
npm test --prefix frontend
npm run lint --prefix frontend
```

- Use the `run` / `verify` skills to launch the app and confirm a UI change actually renders as intended (screenshot it).
- Frontend tests: React Testing Library + Vitest; MSW for API mocking. Keep/extend accessibility coverage.

---

## Keeping this file honest
This repo evolves fast and old MVP assumptions are actively misleading. When a major surface changes: update `AGENTS.md` (canonical), then reconcile the **Product overview** and **Design & UX** sections here. Keep the role split, worktree rules, and team-safe constraint intact.
