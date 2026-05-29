# Assignment Review Tools and Daily Review Handoff

Last updated: May 29, 2026

## Audience

This document is for the team responsible for Ticket Pulse assignment review, assignment pipeline tooling, Daily Review recommendations, and production support for the IT workspace assignment automation.

## Executive Summary

We added LLM-facing assignment tools and updated the Daily Review recommendation system so it no longer treats every improvement as a prompt-only change. The system now exposes the current assignment tool list to Daily Review and Opus consolidation, and prompt recommendations can declare tool/data dependencies when the prompt alone cannot make the behavior reliable.

The main production behavior change is in the IT workspace assignment pipeline. IT prompt v30 is currently published and includes guidance to use the new assignment tools. Other workspace prompts were not intentionally changed.

The key tools now available globally are:

- `get_requester_site_context`
- `get_assignment_risk_signals`
- `get_routing_boundary_context`

`find_matching_agents` was also enhanced to return risk-aware ranking fields.

## Why This Was Done

The Daily Review system had been creating approved prompt recommendations that asked the model to do things a prompt cannot reliably do by itself, such as:

- Suppress technicians who recently rejected a ticket.
- Incorporate real-time availability, workload, or WFH/leave signals.
- Account for requester/site location.
- Detect FreshService routing boundaries such as owner-group or manual-review work.

Those behaviors require data and runtime tools. A prompt can instruct the model to use evidence, but it cannot create missing evidence. The update separates prompt text changes from tools/data requirements and gives the model actual tools for the assignment cases that were already showing up in review findings.

## What Changed

### Assignment Runtime Tools

New global assignment tools were added to `backend/src/services/assignmentTools.js`.

#### `get_requester_site_context`

Purpose:

- Reads ticket text, requester metadata, and optional Microsoft Graph profile data.
- Returns location/site signals and a `preferredLocation` hint when evidence is strong enough.
- Helps the model avoid assigning physical-presence work to remote or mismatched-location technicians.

Expected use:

- Hardware setup, pickup, workstation/laptop, printer, office move, and site-specific tickets.
- The model can skip it for fully remote or generic tickets.

#### `get_assignment_risk_signals`

Purpose:

- Reads same-ticket rejection history, same-day rejection pressure, same-category/subcategory rejection history, current workload, leave/WFH/shift status, and recent busy/unavailable notes.
- Returns structured risk levels, risk penalties, suppression advice, and internal ranking guidance.

Expected use:

- After `find_matching_agents`, when the model has a candidate pool.
- This is the strongest signal that the new tooling is actively being used.

Important privacy rule:

- Risk/rejection/capacity details are internal ranking evidence. They must not be exposed in `agentBriefingHtml`.

#### `get_routing_boundary_context`

Purpose:

- Checks whether a ticket belongs to a FreshService group or internal category that should not be treated as normal IT pool assignment.
- Detects excluded/manual-review groups and SharePoint/Coreshack style owner-group boundaries.
- Returns FreshService group name, group-member compatibility when available, and routing advice.

Expected use:

- Tickets with FreshService group IDs.
- SharePoint, Coreshack, owner-group, onboarding/offboarding child-ticket, or other group-owned routing signals.

### `find_matching_agents` Risk-Aware Output

`find_matching_agents` now includes risk-aware fields in its result:

- `assignmentRisk`
- `baseScore`
- `riskAdjustedScore`
- `scoreFactors`
- `previouslyRejectedThisTicket`
- `riskSummary`

The model should treat these as internal ranking evidence. Public technician briefings should not mention internal scores, risk penalties, rejected candidates, or alternative candidate names.

## Daily Review Recommendation Taxonomy

Daily Review and Backlog categories were simplified to:

- Prompt
- Tools & Data
- Categories
- Agent Skills
- Dev / Policy

The older `Process` category is no longer a first-class target in the UI. Legacy process items are mapped into the newer sections for compatibility.

### Prompt Limitation Gate

Daily Review and Opus consolidation now receive the current available assignment tool list. They are instructed to apply this gate:

- If a recommendation can work with prompt text alone, classify it as `Prompt`.
- If a prompt update depends on an existing tool, the prompt recommendation must list the required tool and explain that dependency.
- If a prompt update needs a missing tool, data feed, API, external action, persistence, or runtime visibility, it should not be treated as prompt-only.
- Missing capabilities should go into `Tools & Data` or `Dev / Policy`.

This prevents the review system from approving impossible prompt-only improvements.

## UI Changes

The Daily Review and Backlog UI now shows the newer category set:

- Prompt
- Tools & Data
- Categories
- Agent Skills
- Dev / Policy

The Backlog category tabs were moved higher and made more prominent. The older Recommendation Review section was reduced so the category workflow is the primary control surface.

Run-detail recommendation approval was also updated so newly generated recommendations use the same category set instead of the old Prompt / Process / Categories / Agent Skills layout.

## Production Prompt State

Production DB verification on May 29, 2026 showed:

| Workspace | Published Assignment Prompt | New Tool Guidance |
| --- | ---: | --- |
| IT | v30 | Yes |
| Accounting Team | v8 | No |
| Health & Safety Team | v10 | No |
| Field Equipment Team | none | No prompt |

IT prompt v30 includes:

- `get_requester_site_context`
- `get_assignment_risk_signals`
- `get_routing_boundary_context`

Versions v28 and v29 remain archived and can be restored from Prompt Manager if needed.

## Production Usage Evidence

Production DB check on May 29, 2026, scoped to IT runs since published prompt v30:

| Metric | Count |
| --- | ---: |
| Total IT pipeline runs since v30 | 54 |
| Completed runs | 54 |
| Runs that used `find_matching_agents` | 41 |
| Matching runs that also used `get_assignment_risk_signals` | 41 |
| Matching runs without `get_assignment_risk_signals` | 0 |
| Runs that used `get_requester_site_context` | 10 |
| Runs that used `get_routing_boundary_context` | 4 |

Interpretation:

- The new risk tool is being used consistently on candidate-ranking runs.
- Requester-site and routing-boundary tools are being used conditionally, which is expected.
- Routing-boundary usage is lower because only some tickets have group/owner-boundary signals.

## Routing-Boundary Fix

### Issue

The first production routing-boundary tool call completed, but FreshService group lookup degraded with:

```text
FreshService domain and API key are required
```

Root cause:

- `getRoutingBoundaryContext` fetched the correct workspace FreshService config.
- It then passed the entire config object into `createFreshServiceClient`.
- `createFreshServiceClient` expects separate `(domain, apiKey)` arguments.

### Fix

Updated:

- `backend/src/services/assignmentTools.js`

Change:

```js
createFreshServiceClient(fsConfig.domain, fsConfig.apiKey)
```

instead of:

```js
createFreshServiceClient(fsConfig)
```

Regression test updated:

- `backend/tests/assignmentToolsRiskSignals.test.js`

The test now asserts the FreshService client is called with the separate domain and API key arguments.

### Post-Fix Verification

A read-only routing-boundary tool check against the prior degraded ticket returned:

- `lookup`: `freshservice`
- `groupName`: `On/Off Boarding`
- `memberIdsKnown`: `true`
- `memberCount`: `15`
- `compatibilityKnown`: `true`
- `error`: `null`

This confirms the group lookup path is no longer failing because of client construction.

## Deployment Notes

Relevant commits:

| Commit | Purpose |
| --- | --- |
| `ffff5d66` | Merge v2.55 Daily Review taxonomy and tool-aware recommendation changes |
| `759bdb1c` | Release v2.55 version/changelog update |
| `bc15c44f` | Fix routing-boundary FreshService client construction |
| `a039e2b4` | Current production branch head at time of this handoff |

Relevant deploy runs:

| Run | Workflow | Result | Notes |
| --- | --- | --- | --- |
| `26617752172` | Backend App Service | Success | v2.55 backend deploy |
| `26617752167` | Static Web Apps | Success | v2.55 frontend deploy |
| `26648052651` | Backend App Service | Success | Routing-boundary client fix deploy |
| `26648053594` | Backend App Service | Failure | Duplicate concurrent deploy hit Azure OneDeploy `409 Conflict`; sibling backend run succeeded |
| `26656666582` | Backend App Service | Success | Later production backend deploy including the fix |

Production health after later deploy:

- Endpoint: `https://ticket-pulse-app.azurewebsites.net/api/health`
- `status`: `healthy`
- `app.version`: `2.55.0`
- `app.environment`: `production`

## Tests Run

Targeted backend regression:

```powershell
$env:DATABASE_URL='postgresql://test:test@localhost:5432/test'
$env:SESSION_SECRET='test-secret'
npm test --prefix backend -- --runInBand assignmentToolsRiskSignals.test.js
```

Result:

- 4 tests passed.

Backend lint:

```powershell
$env:DATABASE_URL='postgresql://test:test@localhost:5432/test'
$env:SESSION_SECRET='test-secret'
npm run lint --prefix backend -- --quiet
```

Result:

- Passed.

## How To Verify Tool Usage

Use the pipeline step table. Tool calls are stored in:

- `assignment_pipeline_steps.step_name`

Useful tool step names:

- `get_requester_site_context`
- `get_assignment_risk_signals`
- `get_routing_boundary_context`
- `find_matching_agents`
- `submit_recommendation`

Sanitized SQL pattern:

```sql
with current_prompt as (
  select id, version, published_at
  from assignment_prompt_versions
  where workspace_id = 1
    and status = 'published'
  order by version desc
  limit 1
),
runs as (
  select r.*,
    exists (
      select 1 from assignment_pipeline_steps s
      where s.pipeline_run_id = r.id
        and s.step_name = 'find_matching_agents'
    ) as used_matching,
    exists (
      select 1 from assignment_pipeline_steps s
      where s.pipeline_run_id = r.id
        and s.step_name = 'get_assignment_risk_signals'
    ) as used_risk,
    exists (
      select 1 from assignment_pipeline_steps s
      where s.pipeline_run_id = r.id
        and s.step_name = 'get_requester_site_context'
    ) as used_site,
    exists (
      select 1 from assignment_pipeline_steps s
      where s.pipeline_run_id = r.id
        and s.step_name = 'get_routing_boundary_context'
    ) as used_boundary
  from assignment_pipeline_runs r, current_prompt cp
  where r.workspace_id = 1
    and r.created_at >= cp.published_at
)
select
  (select version from current_prompt) as current_prompt_version,
  count(*) as total_since_current_prompt,
  count(*) filter (where status = 'completed') as completed,
  count(*) filter (where used_matching) as used_matching,
  count(*) filter (where used_matching and used_risk) as matching_plus_risk,
  count(*) filter (where used_matching and not used_risk) as matching_without_risk,
  count(*) filter (where used_site) as used_site,
  count(*) filter (where used_boundary) as used_boundary
from runs;
```

Expected:

- `matching_without_risk` should usually be `0` for normal IT assignment runs under v30.
- `used_site` and `used_boundary` will be lower because those tools are conditional.

## What The Owning Team Should Know

### Tool Calls Are Model-Driven

The runtime makes the tools available, but the LLM decides which tools to call based on the prompt and ticket evidence. This is expected.

The exception is that `find_matching_agents` itself now returns risk-aware fields, so even when the model does not explicitly call `get_assignment_risk_signals`, some risk-aware ranking can still appear through matching output. Under IT v30, the model has been calling the explicit risk tool consistently on matching runs.

### Tools Are Global, Prompt Guidance Is Workspace-Specific

The tools are globally registered and workspace-scoped at execution time. They can be used by other workspaces if a prompt calls them, but only IT was intentionally updated to request them.

Non-IT impact to watch:

- Existing non-IT prompts should not suddenly mention IT-only concepts.
- If a non-IT prompt calls `find_matching_agents`, risk-aware fields may appear in output. This is expected and uses that workspace's data.

### Routing Boundary Depends On FreshService Group Lookup

`get_routing_boundary_context` can still provide useful policy output from stored ticket/group/category fields without FreshService group members. However, group-member compatibility requires FreshService API lookup to succeed.

Monitor for:

- `freshserviceGroup.lookup` values other than `freshservice`, `not_found`, or `freshservice_not_configured`.
- `memberIdsKnown=false` on tickets where group compatibility matters.
- `candidateGroupCompatibility.memberOfCurrentGroup=null`, which means compatibility could not be determined.

### Priority-Only Runs Can Still Overuse Assignment Tools

Some `priority_only` or priority-triggered runs have called matching/risk tools. The user explicitly accepted this for now.

Do not treat that as a regression unless the team decides priority-only mode must strictly prohibit assignment-ranking tools.

If this becomes a problem, likely fix:

- Enforce a runtime tool allowlist for priority-only mode instead of relying only on prompt instructions.

### Public Briefing Safety

The prompt and tools are designed so risk signals remain internal. QA should continue checking that public `agentBriefingHtml` does not expose:

- Rejection history
- Risk scores
- Risk penalties
- Candidate rankings
- Other candidate names
- LLM/tool names

## QA Checklist

### Basic Health

- Open `https://ticket-pulse-app.azurewebsites.net/api/health`.
- Confirm `status=healthy`.
- Confirm `app.version=2.55.0`.

### Prompt Manager

- In IT workspace, open Assignment Review > Prompts.
- Confirm published prompt is v30 or later.
- Search the prompt text for the three new tool names.

### Normal Assignment Run

- Inspect a recent IT pipeline run that used `find_matching_agents`.
- Confirm it also used `get_assignment_risk_signals`.
- Confirm the run completed without unknown-tool errors.

### Physical/Site Ticket

- Inspect or trigger a safe controlled ticket with site/location evidence.
- Confirm `get_requester_site_context` is used when location matters.
- Confirm the selected candidate reasoning considers location or physical presence.

### Routing-Boundary Ticket

- Inspect or trigger a safe controlled ticket with a FreshService group or SharePoint/Coreshack/onboarding/offboarding boundary.
- Confirm `get_routing_boundary_context` is used.
- Confirm `freshserviceGroup.lookup` is not the old `FreshService domain and API key are required` error.
- Confirm `candidateGroupCompatibility` contains true/false membership values when FreshService group members are available.

### Daily Review Backlog

- Open Daily Review > Backlog.
- Confirm tabs are:
  - Prompt
  - Tools & Data
  - Categories
  - Agent Skills
  - Dev / Policy
- Confirm `Process` is not shown as a main category.

### Consolidation

- Run Opus Consolidation only when the team wants a new consolidation pass.
- Confirm prompt recommendations with tool dependencies list those dependencies.
- Confirm missing tool/data capabilities appear under Tools & Data or Dev / Policy.

## Rollback Guidance

Prompt rollback:

- If IT prompt v30 behavior is bad but the tool guidance is still wanted, restore/publish v29.
- If the new tool-guidance behavior itself is bad, restore/publish v28.

Code rollback:

- Re-deploy a prior backend commit only if tool execution itself is faulty.
- If code is rolled back to a version before these tools exist, do not keep IT prompt v29 or v30 published because both instruct the model to call tools that would no longer exist.

Operational caution:

- IT assignment config has historically allowed auto-assignment. Use controlled tickets for live manual runs.
- Prefer read-only inspection of completed runs when verifying behavior in production.

## Open Follow-Ups

These are not blockers for the current release:

- Decide whether priority-only mode should enforce a hard tool allowlist.
- Add a small admin/reporting view for tool call adoption by workspace and prompt version.
- Add alerting for routing-boundary group lookup failures if group compatibility becomes operationally critical.
- Continue spot-checking `agentBriefingHtml` to ensure internal risk details are not exposed.
