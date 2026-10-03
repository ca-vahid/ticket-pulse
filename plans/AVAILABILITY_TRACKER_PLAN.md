# Availability Tracker: a native Vacation Tracker replacement

Status: **plan, decisions 1/2/5/7 answered 3 Oct 2026; entitlement numbers + rule defaults pending** · Owner: Claude (full stack)
Section name: **Availability** (side rail + page title).
Research: deep-research run `wf_601c4442-371`. That run verified 23 of 25 claims; 2 were refuted. Sources are cited inline as [n].

## Why

- BGC pays extra for Vacation Tracker (VT) and it lacks the features we need.
- Ticket Pulse already depends on availability data for dashboard availability, AI assignment and coverage.
- Accounting doesn't use VT. They keep a shared Outlook calendar, which we read and classify with rules plus an LLM.
- **Goal:** one in-app tracker every team can use for free. IT goes first, then Accounting, then anyone else.

## What we already have (and keep)

| Today | Role in the new tracker |
|---|---|
| `TechnicianLeave` rows (`leaveDate`, `category` OFF/WFH/OTHER, `isFullDay`, `halfDayPart`, `startMinute`/`endMinute`), filled by the VT sync | Becomes a **derived read model**. Approved requests write these rows, so the dashboard, the AI assignment tools and Analytics capacity keep working unchanged. |
| `VtLeaveType`, `VtUserMapping`, `VacationTrackerConfig` + daily sync | Used for **migration and coexistence** (import history and balances), then retired. |
| `CalendarLeave*` (Graph group-calendar reader + rules + LLM) for Accounting | Keeps running until Accounting moves over. It is also how we import their history. |
| `Holiday` (company-wide, moving holidays, 2028 horizon) | Reused as the holiday source. Per-office/province holidays come later. |
| Technician `location`, `timezone`, `workStartTime`/`workEndTime` | Seeds each person's office and working pattern. |
| Teams bot, approval e-mail templates (apDocument), Approvals v3 patterns | Reused for approve-from-Teams/e-mail and for notifications. |

## What VT can't do (our edge, verified)

- **Auto-approval is a plain on/off per leave type and location** [1][2]. There are no capacity or condition rules, so a rule like "Vancouver: more than 3 WFH in a week needs approval" is impossible in VT.
- **Multi-level approval stops at 2 levels**, only on the paid Complete plan, and the chain is set per department [1].
- **Substitute approvers only kick in when every other approver in the department is away** [2]. There are no standing delegates and no escalation.

## Core concepts (data model)

All of these entities are **company-level**, keyed by a person rather than a per-workspace technician. A person can be an agent in several workspaces, or in none (a future employee-only user).

1. **Person**: Entra id + e-mail; office; province/region; employment start date; working pattern (days/hours, so half days and hours compute correctly); manager (from Entra); links to `technicians` rows in each workspace.
2. **Office**: name, province, timezone, holiday calendar, capacity settings. Vancouver, Calgary, Toronto and so on come from the Entra office locations we already map.
3. **Leave type**: name, icon, colour, **unit** (days / half days / hours), **counts against balance** (y/n, and which balance), **needs approval** (default; rules can override), **affects availability** (OFF / WFH / PARTIAL / ON-SITE / NONE, which is what the AI and dashboard read), **visibility** (everyone sees type / team sees "Away" only / private), **requires note**, **allow recurring**, **allow past-dated**, and **category mapping** to today's OFF/WFH/OTHER.
   - Seed types: Vacation, Sick, WFH, Site visit, Training/Conference, Bereavement, Unpaid, Banked/In-lieu, Appointment (hours).
4. **Policy**: a bundle of leave types, rules and accrual plans. It is assigned to a **scope**: company, workspace/team, office, or person. A narrower scope overrides a wider one, and each override is shown with its origin.
5. **Rule**: declarative and scoped (see the rule model below).
6. **Accrual plan**: entitlement, schedule, tenure tiers, carry-over, expiry, statutory floor.
7. **Balance ledger**: an append-only ledger per person and balance (accrual, taken, adjustment with reason, carry-over, expiry). The balance is always the sum of the ledger, never a mutable number.
8. **Request**: person, type, dates or day-parts or hours, recurrence, note, status (draft, pending, approved, denied, cancelled, cancel-requested), and a **decision trail** (which rules fired, who decided and when, comments).
9. **Approval group** (Vahid, 3 Oct 2026; Entra has no managers and BGC is fairly flat):
   - an admin-made group of **people** (e.g. Accounting AP, Accounting AR, IT Service Desk), each with its own **approval admins**, added by hand;
   - a person can belong to several groups, and an approver can run several groups;
   - a group can be set to **auto-approve** some or all leave types (some Accounting sub-groups are auto-approved today);
   - delegates (standing and date-bounded), escalation timers and multi-level chains attach to the group;
   - **no Entra-manager approver.**
10. **Calendar link**: the Outlook event id and auto-reply state per approved request.

## Rule model (the main feature)

A rule = **scope** + **applies to (leave types)** + **condition** + **outcome** + **message**. Rules are evaluated at request time and **every decision stores the rules that fired**, so "why was this auto-approved / sent for approval / refused" is always answerable.

**Conditions (MVP)**
- `advance_notice` — min/max lead time (e.g. WFH no more than **N weeks** ahead, vacation at least **N days** ahead).
- `capacity` — count of people with an *approved or pending* request of the given types in the same scope (office / team / workspace) in a window (day / week). Example: "Vancouver, WFH, per week, more than 3 → needs approval."
- `duration` — max consecutive days; max days per year for this type.
- `blackout` — date ranges (e.g. year-end close for Accounting).
- `balance` — the request exceeds the available balance (or a negative-balance allowance).
- `past_dated` — the start date is in the past.
- `coverage` *(v2)* — at least N people from a team or group must remain available.

**Outcomes**
- `auto_approve`
- `needs_approval` (optionally naming the approval chain)
- `refuse` (hard stop, with the message)
- `warn` (the requester sees it but can still submit)

**Evaluation order**
1. A `refuse` wins.
2. Otherwise any `needs_approval` sends the request for approval.
3. Otherwise the leave type default applies: needs approval or auto-approve.
4. `warn`s are shown either way.

The engine is deterministic and explainable, with no LLM in the decision. This matches the Analytics rule.

## Approvals

- Approvers come from **approval groups** (see Approval group above), set up by hand. Entra managers are not used.
- A person's request goes to the approvers of every approval group they belong to that covers that leave type. The first decision wins; a group may require all of its approvers instead.
- A group or leave type set to auto-approve skips approval, unless a rule (e.g. office capacity) sends the request for approval anyway.
- Delegates and escalation:
  - **standing delegate**, plus **date-bounded delegate** (automatic while the approver is on approved leave, better than VT [2]);
  - **escalation**: no decision in X hours → the next approver or an admin.
- Multi-level chains (N levels) with **conditional chains**. For example, vacation over 10 days → manager, then office lead.
- Decisions:
  - approve; deny with a reason; **approve with changes** (e.g. shorten the range, which the requester accepts);
  - cancel: the requester can cancel a pending request outright, and needs approval to cancel an approved one.
- Approve from **Teams** (bot card, existing bot), **e-mail** (actionable buttons, existing apDocument pattern) or the in-app queue.
- Full audit trail on every request and balance change.

## Balances & accruals

- **Entitlement**:
  - annual, or accrued monthly or per pay period;
  - **tenure tiers** keyed on the employment start date;
  - **pro-rated** for mid-year starters;
  - **carry-over cap and expiry date**;
  - **negative balance** allowance per type;
  - fiscal year or calendar year per policy.
- **BC statutory floors (verified)**, modelled as configurable minimums that company policy can exceed:
  - **Vacation**: 2 weeks after 12 months, 3 weeks after 5 consecutive years, earned at each anniversary, and the statutory part must be **taken within 12 months** of being earned [3][4].
  - **Sick**: up to **5 paid days a year after 90 consecutive days** of employment, plus 3 unpaid days. Resets yearly with **no carry-over** [5].
  - Other provinces get their own floor sets (v2).
  - ⚠ **To confirm with HR**: one verifier flagged that BC ESA Regulation s.31 may exclude registered professional engineers and geoscientists from parts of the ESA. If so, the floors don't cover much of BGC's staff and company policy is the real source of entitlements.
- **Reports**:
  - per person and year: entitled, taken, scheduled, remaining, carried over;
  - a "total vacations taken this year" view;
  - CSV export for payroll.

## Calendars, visibility, privacy

- **My availability** page:
  - balances;
  - upcoming requests;
  - a 2–3-click request flow: type, dates or half days or hours, submit, with live rule feedback ("auto-approved", "needs approval because 4 others are WFH in Vancouver that week").
- **Team/office calendar**: month and week views, a "who's out today / this week" panel, filters by office, team and type.
- **Privacy (BC PIPA)** [6]:
  - collect only what's needed;
  - a purpose notice;
  - per-type visibility, so a **sick day shows to teammates as "Away"** and its reason is never shown;
  - leave data visible only to the person, their approvers and admins, beyond the "Away" status.
- **Microsoft 365 write-back (Vahid, 3 Oct 2026)**:
  - two separate admin switches, **both OFF at launch**: *Outlook calendar event* and *Automatic replies*;
  - when a switch is on, the request form asks the person each time ("Add to my Outlook calendar", "Set my automatic reply"), and nothing is written without that tick;
  - Vahid (Global Admin, az login) will grant consent when we turn it on; we will not request permissions before then (least privilege).
- **Microsoft 365 write-back (app-only, verified)** [7]:
  - on approval, create an Outlook event with `showAs: oof` in the person's own calendar (`Calendars.ReadWrite` application permission);
  - optionally schedule Outlook **automatic replies** (`MailboxSettings.ReadWrite`; future dates only, and the message text must be set);
  - both need tenant admin consent and should be **scoped to a mail-enabled security group** through Exchange Application Access Policy or RBAC for Apps.
- **Group calendars**:
  - writing into a **Microsoft 365 group** calendar is *not* possible app-only; it needs a delegated token [8];
  - if Accounting's calendar is a group calendar, we keep reading it during coexistence and write only to personal calendars;
  - if it's a **shared mailbox**, app-only writes work.
- Daily **"who's out" digest** to a Teams channel (v2). iCal feed per team (later).

## Ticket Pulse integration (why this belongs here)

Zendesk's pattern [9] (verified):
- **Approved OFF leave is a hard filter for auto-assignment** but only a **warning on manual assignment**.
- Open tickets, and tickets reopened during an absence, can be **reassigned automatically**, with separate settings for each.

For us:
- **AI assignment** reads availability per day-part:
  - OFF → unavailable;
  - WFH → available;
  - Site visit → configurable: *available, slow response* or unavailable;
  - hours → "available from HH:MM", as `startMinute` already supports.
- **Manual assignment pickers** show "Away until Mon" next to the name.
- **Away handling** (v2): reassign or park the person's open tickets during long leave, as a per-workspace setting.
- The Dashboard availability bar and Analytics capacity keep working through the `TechnicianLeave` read model.

## Migration & coexistence

1. **Import from VT** using the v1 API (read-only: departments, locations, labels, leave types, leaves, users) [10], plus the **Leave Balance Report** CSV/Excel (entitlement, taken, scheduled, brought forward, remaining per user and type) [11].
   - VT v2 has read/write and webhooks [10]; possible two-way sync during the transition, plan tier to confirm.
2. **Parallel run** (2–4 weeks): IT requests in Ticket Pulse; the VT sync is kept read-only for anyone not yet moved; we compare totals.
3. **Cut-over**: switch off the VT sync per workspace, then cancel VT.
4. **Accounting**: import their calendar history (the classifier already exists), set up their types and policies, and switch them from calendar-reading to requests.

## Phases

**MVP (v1): replaces VT for IT**
- Person, Office, Leave type, Policy scopes, Rule engine (advance notice, capacity, duration, blackout, balance, past-dated).
- Request flow (days, half days, hours), approval groups (hand-made, several per person, auto-approve per group or type, standing delegate, one level), approve from Teams and e-mail, in-app queue.
- Balances: annual entitlement + tenure tiers + pro-rata + carry-over cap; ledger; adjustments with reason.
- My availability page, team calendar, who's out, per-type privacy.
- `TechnicianLeave` read model fed from approved requests; AI assignment and dashboard unchanged.
- VT import (history + balances) and parallel run.
- Outlook OOO event + automatic replies built behind two admin switches (off), with a per-request confirm.
- Settings → "Availability" (types, rules, approvers, offices) for admins; individual users see "My availability" in their settings.

**v2**
- N-level and conditional chains, escalation timers, approve-with-changes.
- Recurring requests (every Friday WFH).
- Coverage rule.
- Monthly/pay-period accrual, expiry, negative balance.
- Automatic replies.
- Teams "who's out" digest.
- Other provinces' floors.
- Away-handling ticket reassignment.
- Accounting onboarding.

**Later**
- iCal feeds, payroll export formats, liability report, per-office holiday calendars, employee-only users (non-agents), Teams presence.

## Decisions for Vahid

1. ~~Who uses it first~~ → **Ticket Pulse users** (agents and members per workspace). The person model is ready for all employees later.
2. ~~Approvers~~ → **hand-made approval groups with their own approval admins**, auto-approve per group, no Entra managers.
3. **Entitlements**:
   - What are BGC's actual vacation tiers (beyond the BC floor) and sick days?
   - Calendar or fiscal year?
   - Carry-over cap?
   - Do the BC floors even apply to P.Eng/P.Geo staff (confirm with HR)?
4. **Rule defaults to seed**:
   - WFH: max how many weeks ahead?
   - Capacity per office (Vancouver 3/week; others?).
   - Vacation minimum notice.
   - Site visits auto-approved.
   - Sick auto-approved.
5. ~~Outlook write-back~~ → OOO event and/or automatic replies, two admin switches, **off at launch**, and the person confirms on each request.
6. **Accounting's calendar**: answered from our config. It's read through `graph_group_calendar` with a Graph **group id**, so it's an M365 group calendar. During coexistence we read it and never write to it.
7. ~~Name~~ → **Availability**.

## Sources

1. https://vacationtracker.io/helpdesk/how-to-set-up-multi-level-approvals/
2. https://vacationtracker.io/capability/leave-approval/
3. https://www2.gov.bc.ca/gov/content/employment-business/employment-standards-advice/employment-standards/time-off/vacation
4. https://www2.gov.bc.ca/gov/content/employment-business/employment-standards-advice/employment-standards/forms-resources/igm/esa-part-7-section-58
5. https://www2.gov.bc.ca/gov/content/employment-business/employment-standards-advice/paid-sick-leave
6. https://www.oipc.bc.ca/guidance-documents/2098
7. https://learn.microsoft.com/en-us/graph/api/user-update-mailboxsettings?view=graph-rest-1.0
8. https://learn.microsoft.com/en-us/graph/api/calendar-post-events?view=graph-rest-1.0
9. https://support.zendesk.com/hc/en-us/articles/9333239893658-Workflow-Replacing-the-Out-of-Office-app-with-omnichannel-routing
10. https://vacationtracker.io/developers/api
11. https://vacationtracker.io/knowledge-base/how-do-i-export-employee-leave-balances/

**Research limits.** Competitor coverage beyond VT (Timetastic, Calamari, BambooHR, Personio, Factorial, Teams Shifts), recurring/hourly UX, accrual edge cases and reporting were not verified by the research run. Those parts of the plan are design judgment.
