# AI Provider Failover Runbook

## Scope

Ticket Pulse uses a workspace-scoped AI provider gateway for assignment, competency analysis, Daily Review, Daily Review consolidation, ticket reclassification, calendar leave classification, and auto-response classification/generation.

Supported providers:

- Anthropic Messages API
- OpenAI Responses API

Provider settings are stored per workspace and operation in `ai_provider_settings`. Attempts are audited in `ai_provider_attempts`; rolling health events are stored in `ai_provider_health_events`.

## Health Classification

Health is computed from a rolling 5-minute window:

- `healthy`: recent attempts are succeeding.
- `degraded`: at least one recent failure, or a provider just recovered and is still inside dwell time.
- `down`: config/auth failures after the latest success, or three consecutive recent failures.
- `unknown`: no recent events.

Routing skips providers with `routingEligible=false`. After a success following a failure, the provider stays in dwell time for 2 minutes before new traffic is routed back.

## Testing Providers

Use the admin UI provider panel or API:

```bash
GET /api/ai-providers/settings
GET /api/ai-providers/health?operation=assignment_pipeline
POST /api/ai-providers/test
```

Example body:

```json
{
  "operation": "assignment_pipeline",
  "provider": "openai",
  "model": "gpt-5.5"
}
```

Tool-capable operations use a small test tool. Simple JSON operations use the same JSON call path as production.

There is also a local smoke helper:

```bash
$env:TICKET_PULSE_API_URL="https://<app>.azurewebsites.net/api"
$env:TICKET_PULSE_AUTH_TOKEN="<admin jwt>"
$env:TICKET_PULSE_WORKSPACE_ID="1"
node scripts/ai-provider-smoke.mjs
```

## Forcing A Provider Down In Staging

Use staging only.

1. Remove or replace the provider key in staging App Service/Key Vault, for example `ANTHROPIC_API_KEY`.
2. Restart the staging app service so the environment change is loaded.
3. Run `POST /api/ai-providers/test` for the affected provider and confirm it records `config_missing` or `auth_error`.
4. Start a safe operation, such as a dry-run/review workflow, and confirm the fallback provider succeeds.

Do not run this drill in production during business hours.

## Verifying Fallback Attempts

Check the UI run detail first. It should show provider/model badges and a fallback banner when fallback was used.

Database checks:

```sql
SELECT operation, provider, model, attempt_number, status, fallback_from_provider,
       fallback_reason, error_class, started_at, completed_at
FROM ai_provider_attempts
ORDER BY started_at DESC
LIMIT 25;
```

```sql
SELECT provider, operation, success, error_class, sanitized_message, created_at
FROM ai_provider_health_events
ORDER BY created_at DESC
LIMIT 25;
```

## Recovering After Both Providers Fail

1. Check App Service configuration and Key Vault references for both keys.
2. Test each provider from `/api/ai-providers/test`.
3. Review `ai_provider_health_events` for the current error class.
4. If both providers are down, leave auto-fallback enabled but pause risky AI workflows if needed.
5. For auto-response, confirm the configured fallback message is acceptable because it is the final non-AI fallback.

## Cost Notes

Provider costs differ by model and operation. Keep high-effort models such as Opus for consolidation only unless quality testing justifies broader use. Prefer lower-cost models for batch classification after spot-checking quality.

## Azure Deployment Notes

Set these as App Service settings or Key Vault references:

- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- Existing model defaults such as `ANTHROPIC_MODEL`, `ANTHROPIC_RECLASSIFICATION_MODEL`, and `OPENAI_MODEL` where configured

Run Prisma migrations before enabling provider settings:

```bash
npm run prisma:deploy --prefix backend
npm run prisma:generate --prefix backend
```

## Application Insights Queries

Provider failures:

```kusto
traces
| where message has "AI provider attempt failed"
| order by timestamp desc
```

Fallback usage in app logs:

```kusto
traces
| where message has "provider_fallback_started" or message has "fallback"
| order by timestamp desc
```

Use database counts for authoritative fallback rates:

```sql
SELECT operation, provider, status, error_class, count(*)
FROM ai_provider_attempts
WHERE started_at >= now() - interval '24 hours'
GROUP BY operation, provider, status, error_class
ORDER BY operation, provider, status;
```
