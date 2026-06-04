# Notification Workflow Go/No-Go Note - 2026-06-04

Decision: no-go for live-send expansion today. Keep enabled workflows in mock mode until one business day of post-deploy production mock evidence is available.

## Evidence

- Runtime deployed on main: `95ec499a6d7f263342c5164c07496c8f775de770`.
- Backend deployment: `Deploy Backend to Azure App Service` run `26934657684`, success.
- Frontend deployment: `Azure Static Web Apps CI/CD` run `26934657673`, success.
- Production health: `https://ticket-pulse-app.azurewebsites.net/api/health` returned healthy after deployment.
- Immediate post-deploy audit: `scratchpad/notification-workflow-postdeploy-audit-2026-06-04.json`.
- Latest deployed-commit audit checkpoint: `scratchpad/notification-workflow-postdeploy-audit-95ec499a-2026-06-04.json`.
- Claude canary: `scratchpad/notification-workflow-claude-canary-2026-06-04.json`.

## Passed Gates

- Deployment completed for backend and frontend.
- Production health check passed after deployment.
- Immediate audit showed zero real mocked duplicate groups in the inspected window.
- Immediate audit showed compact delivery payloads with no active contact objects, base64 image data, avatar/photo fields, or email-like payload findings.
- Required Claude canary cases passed:
  - OpenAI and Claude both completed the same tool-enabled workflow contract.
  - Forced `find_similar_tickets`, `detect_related_ticket_spike`, and `submit_notification_email` continuation succeeded for both providers.
  - Claude direct generation on ticket `225380` completed without guard rejection or fallback.
- Audit-only relaxed style findings now surface as `llm_warning`, not `llm_failed`.

## Open Gates

- One business day of post-deploy production mock evidence is not available yet.
- The latest deployed-commit checkpoint after `95ec499a` had zero workflow runs, zero deliveries, and zero LLM/provider attempts, so it cannot prove launch readiness.
- Immediate audit was generated shortly after deployment and mostly covers pre-deploy workflow runs; it should not be treated as launch evidence.
- `possible_broader_issue` rate in the immediate audit window was still review-level and needs post-deploy confirmation.
- Historical provider/schema fallbacks in the audit window were pre-fix rows; post-deploy provider/schema failure rate still needs a non-zero mock sample.
- Claude timing-repair canary did not produce a repairable unsupported timing claim. The first attempt hard-blocked a direct email address, and the retry avoided the unsupported timing claim. Timing repair remains covered by focused automated tests.

## Live-Send Scope

- Current live-send scope: none.
- Proposed next scope after gates pass: keep only the currently enabled requester-facing workflows eligible, start with one workspace, and leave all other workflow variants in mock mode.

## Rollback And Monitoring

- Rollback first action: set affected workflow `mockModeEnabled=true`.
- Rollback second action: set affected workflow `isEnabled=false` if duplicate risk, privacy risk, or bad copy is observed.
- Monitor and pause live-send expansion if any of these appear after deployment:
  - real duplicate workflow delivery groups greater than zero,
  - provider/schema failures greater than zero,
  - template fallback count greater than zero,
  - guard hard-block count greater than zero,
  - payload minimization failure greater than zero,
  - `possible_broader_issue` rate above 25% without clear operational evidence.
