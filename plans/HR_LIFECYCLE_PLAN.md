# Onboarding / Offboarding (QA 10-01 #8) — build plan

Source: QA package 10-01, item 8 (Susan Xu). Workspace: IT (ws1) only for now. Research: `plans/HR_LIFECYCLE_RESEARCH.md` (production data, 1 Oct 2026).
Status: building in 4.1.3x. **Ships disabled** — FreshService stays the live organiser until Vahid switches it on.

## Vahid's decisions (1 Oct 2026, verbatim intent)

| Topic | Decision |
|---|---|
| Offboarding children | **5 by default**: Laptop, Phone, iPad, Disable Account, Decommissioning Account. Not hard-coded — editable in settings ("maybe simplify"). |
| After-the-fact departure | Sudden departures: HR has IT disable the account first, the e-mail comes later. Then **3 children: Laptop, Phone, iPad**. |
| Detecting after-the-fact | **Automatic** when the notice arrives on/after the last day or says "effective immediately"; plus a one-click **"Switch to after-the-fact"** on the parent that closes the extra children with a note. |
| Onboarding | Today: one BambooHR "New Hire" notice, then Sam's automation creates "NH Laptop" + "NH Workstation" (desk) once the account exists. **Split into 3: the new-hire parent + Laptop + Workstation children.** Sam's automation will be stopped; until then an arriving NH ticket for a person with an open family is linked to that family (never a duplicate child). |
| Where tickets live | **Ticket Pulse.** Children are TP-born (`TP-<n>`), mirrored to FreshService as fallback copies like every native ticket. |
| Parent | The HR notice ticket itself is the parent (no duplicate parent), assigned to **Vahid** (setting: parent assignee). Parent cannot close while children are open (existing open-children close guard). |
| Child assignment | **Default assignee (or group) per child kind**, seeded from today's pattern; **editable**, with **full transparency**: every settings change is logged (who/when/before→after) and shown. Blank default → normal AI routing. |
| Due dates | Children and parent due on the departure / start date from the notice (park-date rules). Decommissioning Account = last day + 7 days (observed). Each offset is a setting. |
| Departure date change | "Departure Notification: X's departure date has changed" → move the due date of the parent + every open child; internal note on every ticket in the family. Same for "start date has changed" (onboarding) and contract-end changes. |
| Cancellation | "will no longer be departing" / "will no longer be starting" → **close the parent and every open child with an internal note** quoting the notice; closed children stay closed. |
| Leave / office change | **The notice is the ticket** — no new ticket: categorise, assign per settings, due/park on the leave start (or move) date; return-from-leave the same. |
| UI | Own section with its own sidebar icon ("Onboarding"), IT workspace only for now. |
| Default state | **Off** (per-workspace). Also an **observe** mode: records what it would do (family preview) without creating anything — for the go-live rehearsal. |

## Model
- `hr_lifecycle_settings` (one row per workspace): `mode` off|observe|live, `parentAssigneeTechId`, `templates` JSON (offboarding_standard, offboarding_after_fact, onboarding — each an ordered list of `{ key, title, dueOffsetDays, assigneeTechId?, groupId? }`), `leave` / `officeChange` handling, updatedAt/updatedBy.
- `hr_lifecycle_settings_changes` — append-only audit: who, when, field path, before, after.
- `hr_lifecycle_families` — one per person event: `kind` offboarding|onboarding|leave|office_change, `parentTicketId`, person name/email/employee id (BambooHR id when present — the stable key), office, `effectiveDate`, `afterTheFact`, `status` open|closed|cancelled, `template` used, `source notice ids` (JSON list), timestamps.
- `hr_lifecycle_family_members` (or JSON on the family) — child ticket ids with their template key.
- `hr_lifecycle_events` — every notice handled + decision + outcome (observe mode writes here only).

## Flow
1. Ticket created in an enabled workspace from `humanresources@…` or `notifications@app.bamboohr.com` → classifier (subject patterns from the research, §1–2) → `{ type, person, dates, office, employeeId }`. Unknown type → recorded, no action.
2. Departure / new hire → find an open family for the person (employee id, then normalised name + type); none → create family: assign parent, set parent due, create children from the template (TP-born, linked parent/child), due + assignee per child. Observe → record the would-be family only.
3. Date change → family found → update parent + open children due dates, internal note on all. Not found → record + note on the notice.
4. Cancellation → close open family members with note, family `cancelled`.
5. Leave / office change → act on the notice ticket itself (assign, due, park via the existing park service).
6. Sam's NH Laptop / NH Workstation ticket arriving for a person with an open onboarding family → link to the parent as related + internal note (no new child).
7. Password guard: never copy or quote a notice/NH body line that carries an initial password (research §security) — strip `password`-labelled lines from anything written into child descriptions or notes.

## API / UI
- `GET/PUT /api/hr-lifecycle/settings` (admin), `GET /api/hr-lifecycle/settings/changes`, `GET /api/hr-lifecycle/families` (filters), `GET /api/hr-lifecycle/families/:id`, `POST /api/hr-lifecycle/families/:id/after-the-fact`, `GET /api/hr-lifecycle/events`, `POST /api/hr-lifecycle/preview` (classify a ticket id → what would happen).
- Page `/onboarding` with sidebar icon: tabs **People** (families: person, type, date, progress n/m children, status), **Activity** (handled notices + decisions), **Settings** (mode, parent assignee, the three child lists with title/due offset/assignee, detection rules read-only, change history).

## Tests
Classifier against redacted real subjects/bodies from the research; family creation (5 / after-the-fact 3 / onboarding 2); date change moves all due dates + notes; cancellation closes; observe writes nothing; settings audit; NH link; password stripping; route auth (admin).
