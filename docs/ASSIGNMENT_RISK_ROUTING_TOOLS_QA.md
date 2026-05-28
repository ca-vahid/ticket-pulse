# Assignment Risk and Routing Tools QA Guide

## Purpose

This guide covers QA for the production deployment that added assignment-risk, requester-site, and routing-boundary tooling to the assignment pipeline.

The change was deployed to the backend on May 28, 2026 from branch `codex/assignment-tools-prod-deploy`, commit `5aaa2b8c`. IT workspace prompt version `29` is published in production.

## What Changed

New global assignment tools are available to the LLM runtime:

- `get_requester_site_context`: reads ticket/requester location signals and optional Entra profile data to produce a site/location hint.
- `get_assignment_risk_signals`: reads same-ticket rejections, same-day rejection pressure, same-category/subcategory rejection history, workload, leave, WFH, shift, and recent busy/unavailable notes for candidate technicians.
- `get_routing_boundary_context`: checks Freshservice group/category boundaries, including excluded groups and owner-group style routing such as SharePoint/Coreshack.

`find_matching_agents` also now includes risk-aware output:

- `assignmentRisk`
- `baseScore`
- `riskAdjustedScore`
- `scoreFactors`
- `previouslyRejectedThisTicket`
- `riskSummary`

The IT assignment prompt now explicitly instructs the model to use those tools. Other workspace prompts were not changed.

## Safety Notes

Production IT assignment config currently has `autoAssign=true` and `dryRunMode=false`. A manual pipeline trigger on an eligible IT ticket can create real assignment and Freshservice writeback activity.

For IT manual-run QA, use only controlled tickets or tickets approved by the coordinator for testing. For read-only QA, inspect completed pipeline runs and prompt/tool configuration instead of triggering new runs.

Accounting and Health & Safety currently have `autoAssign=false`; manual runs there should produce pending review rather than auto-assignment, but they can still create pipeline run records and update classification/priority fields.

## Deployment Checks

1. Open production health:
   - `https://ticket-pulse-app.azurewebsites.net/api/health`

2. Expected:
   - `status` is `healthy`
   - `app.environment` is `production`
   - `app.version` is `2.52.1`
   - database check is healthy

3. In GitHub Actions, backend workflow run `26607240576` should be successful.

4. PR for source alignment:
   - `https://github.com/ca-vahid/ticket-pulse/pull/30`

## Prompt Checks

Workspace: IT

1. Go to Assignment Review > Prompts.
2. Confirm the published assignment prompt version is `29` or later.
3. Search the prompt text for:
   - `get_requester_site_context`
   - `get_assignment_risk_signals`
   - `get_routing_boundary_context`
   - `## Step 4b: Check Risk and Routing Boundaries`

Expected:

- All markers are present.
- Version `28` is archived.
- The prompt says risk/capacity/routing-boundary signals belong in internal reasoning, not in the public technician briefing.

## Tool Registry Checks

Workspace: IT

1. In the admin tool list, or via authenticated API `GET /api/assignment/tools`, confirm these tools are listed:
   - `get_requester_site_context`
   - `get_assignment_risk_signals`
   - `get_routing_boundary_context`

Expected:

- All three tools are visible.
- Existing tools are still present.
- No duplicate tool names appear.

## Functional Test Matrix

### 1. Requester Site / Physical Presence

Use a controlled IT ticket where the subject/body clearly mentions a location or physical work, for example a laptop setup, hardware pickup, desk move, printer issue, or office-specific request.

Steps:

1. Run the assignment pipeline only if the ticket is safe for live assignment.
2. Open the pipeline run detail.
3. Inspect tool calls and reasoning.

Expected:

- `get_ticket_details` runs first.
- `get_requester_site_context` is called when the ticket has location or physical-presence evidence.
- `find_matching_agents` receives or reflects the preferred location when confidence is medium/high.
- WFH or off-site technicians are not preferred for physical-presence work unless the reasoning explains why no better option exists.
- The public `agentBriefingHtml` may mention the user need and site need, but must not mention internal scores, rejected candidates, risk penalties, or tool names.

### 2. Rejection / Capacity Risk

Use a controlled IT ticket with a recent reassignment/rejection history, or inspect a recent rebound run.

Steps:

1. Open the pipeline run detail.
2. Check the tool transcript.
3. Compare the ranked recommendation list with the prior rejecter, if present.

Expected:

- `get_assignment_risk_signals` is called after `find_matching_agents`.
- A technician who already rejected the same ticket should have `previouslyRejectedThisTicket=true` or equivalent risk evidence in internal output.
- A prior rejecter should not be rank 1 if any plausible alternative exists.
- Internal reasoning can mention rejection/capacity risk.
- Public `agentBriefingHtml` must not use words such as `rejected`, `rebound`, `score`, `ranked`, `algorithm`, `LLM`, or expose other candidate names.

### 3. SharePoint / Coreshack / Owner-Group Routing

Use a controlled IT ticket that is clearly group-owned, such as SharePoint/Coreshack work, or inspect a recent run for that kind of ticket.

Steps:

1. Run or inspect the pipeline.
2. Check whether the ticket has a Freshservice group ID or category text matching owner-group work.
3. Open the tool transcript and recommendation reasoning.

Expected:

- `get_routing_boundary_context` is called for SharePoint/Coreshack or group-owned signals.
- If the Freshservice group is in an excluded/manual-review boundary, the recommendation should not force a normal IT pool assignment.
- Candidate group compatibility should affect ranking when Freshservice group membership is available.
- The run may correctly land as pending review if routing ownership is ambiguous or excluded.

### 4. Normal Routine IT Ticket

Use a controlled routine remote ticket with no location, no recent rejection history, and no special group boundary.

Expected:

- The pipeline should still complete normally.
- `find_matching_agents` should return risk-aware candidate fields, but severe risk penalties should be absent or low.
- The new tools should not make a simple ticket fail schema validation.
- If `get_requester_site_context` is not needed, the model can skip it.
- If `get_routing_boundary_context` is not needed, the model can skip it.

### 5. Priority-Only / Classification-Only Runs

Inspect or trigger only if safe.

Expected:

- Priority-only mode should not call `find_matching_agents`, `get_assignment_risk_signals`, `get_routing_boundary_context`, or `get_requester_site_context` unless directly needed for priority/classification evidence.
- Classification-only mode should not change assignee.
- Existing priority persistence should still populate `assessedPriority`, `priorityRationale`, and `priorityConfidence`.

## Daily Review / Consolidation Checks

The approved Daily Review backlog is not automatically cleared by this deployment. This change gives the runtime the tools that the approved recommendations needed.

Steps:

1. Go to Assignment Review > Daily Review > Consolidation.
2. Confirm approved recommendation items are still visible if they were not explicitly applied.
3. Run Opus Consolidation only if the team wants a fresh consolidation plan.
4. Review any prompt recommendation it produces.

Expected:

- Consolidation should no longer need to ask for impossible "prompt-only" behavior for availability, rejection, site, or group-boundary decisions.
- If it suggests prompt changes, they should reference the now-existing tools rather than inventing tools.
- Applying a consolidation item should create a draft/published artifact according to the existing UI flow; verify before publishing.

## Other Workspace Impact

Production read-only checks on May 28, 2026 found:

| Workspace | Published Prompt | Prompt Includes New Tool Guidance | Runtime Tool Smoke |
| --- | ---: | --- | --- |
| IT | v29 | Yes | Passed |
| Accounting Team | v8 | No | Passed |
| Health & Safety Team | v10 | No | Passed |
| Field Equipment Team | none | No prompt | Passed |

Expected impact outside IT:

- The three tools are globally registered and workspace-scoped, so they are available everywhere.
- Accounting and Health & Safety prompts were not updated to request these tools.
- Field Equipment has no published assignment prompt/config, so no assignment-prompt behavior is expected there.
- If a non-IT prompt or model still calls `find_matching_agents`, candidates may now include risk-aware ranking fields and may be down-ranked for recent rejection/capacity signals. This is expected and is scoped to the current workspace data.
- A requester not found in Entra may produce a Graph not-found warning in logs, but `get_requester_site_context` should still return successfully using ticket/requester text evidence.

Regression checks for non-IT workspaces:

1. Open latest Accounting and Health & Safety pipeline runs.
2. Confirm runs complete without unknown-tool errors.
3. Confirm recommendations stay workspace-specific and do not mention IT-only categories such as SharePoint/Coreshack unless the ticket actually contains that evidence.
4. Confirm public briefings do not expose internal scores, risk penalties, or other candidate names.

## Failure Indicators

Escalate if any of these occur:

- Pipeline transcript shows `Unknown tool` for one of the new tool names.
- A run fails schema validation after a new tool call.
- A prior same-ticket rejecter is rank 1 while another plausible candidate exists.
- A physical-presence ticket is assigned to WFH/off-site staff without clear justification.
- SharePoint/Coreshack or excluded-group tickets are forced into normal IT pool assignment without routing-boundary reasoning.
- Public technician briefing exposes internal routing data, including risk, rejection, score, rank, workload counts, or other candidate names.
- Accounting, Health & Safety, or Field Equipment prompt versions change unexpectedly during IT-only testing.

## Rollback Expectations

Prompt rollback:

- Restore/publish IT prompt version `28` from Assignment Review > Prompts if prompt behavior is the problem.

Code rollback:

- Re-deploy the previous backend commit from `main` only if tool execution itself is faulty.
- If code is rolled back, do not keep IT prompt v29 published because it instructs the model to call tools that would no longer exist.
