# Ticket Pulse — Backup & Restore Runbook

Last updated: 2026-08-01 (Phase 1 of `plans/BACKUP_RESTORE_PLAN.md`).

## What protects what

| Layer | Mechanism | Scope / retention | Where |
|---|---|---|---|
| Platform PITR | Azure PG Flexible Server automated backups | Whole server, any point in last **35 days** | `ticket-pulse-pg` (West US 2, rg `ticket-pulse-rg`) |
| Long-term vault | Azure Backup (Data Protection) weekly **pg_dump** | Whole server, vaulted (immutable-ish), months–years per policy | vault `tp-backup-vault`, policy `tp-pg-weekly-ltr` |
| Attachment blobs | Storage **versioning + 30-day soft delete** | Every blob overwrite/delete recoverable 30d | account `ticketpulsestorage` |
| App snapshots | Ticket Pulse **Backup & Restore** (Settings → Sync & Data) | Config + TP-native data, per-workspace or site, on-demand + scheduled | Azure Blob container `backups*` + `backup_snapshots` table |

## Scenario 1 — bad data change / bad deploy corrupted rows (last ≤35 days)
1. Identify the target restore time (before the incident).
2. `az postgres flexible-server restore --resource-group ticket-pulse-rg --name ticket-pulse-pg-restored --source-server ticket-pulse-pg --restore-time "<ISO-8601 UTC>"` (creates a NEW server; the original stays up).
3. Compare/extract the needed data from the restored server (temporary firewall rule for your IP: see below), or fully cut over: stop the app, repoint `DATABASE_URL` (App Service config `ticket-pulse-app`), run `npx prisma migrate deploy`, restart, verify `/health`, run a sync cycle.
4. Delete the spare server when done.

## Scenario 2 — need something older than 35 days
Azure portal → Backup center (or `az dataprotection recovery-point list -g ticket-pulse-rg --vault-name tp-backup-vault --backup-instance-name <instance>`) → restore the weekly pg_dump to blob → `pg_restore` into a scratch server → extract.

## Scenario 3 — someone broke configuration (workflows, rules, taxonomy…)
Use the in-app restore: Settings → Sync & Data → **Backup & Restore** → pick a snapshot →
Restore wizard → select just the affected module(s) → review the dry-run diff → Merge (or
Replace for an exact rollback). No downtime, no infra involvement.

## Scenario 4 — deleted/overwritten attachment blob
`az storage blob list --account-name ticketpulsestorage -c <container> --include d,v` → find the
version/soft-deleted blob → undelete/promote the prior version.

## Access notes
- Prod DB is firewalled to Azure egress. Temporary access:
  `az postgres flexible-server firewall-rule create -g ticket-pulse-rg -n ticket-pulse-pg --rule-name tmp-<who>-<date> --start-ip-address <ip> --end-ip-address <ip>` — **delete the rule when done**.
- In Git Bash, prefix az commands using resource-id scopes with `MSYS_NO_PATHCONV=1`.
- `PROD_DATABASE_URL` lives in `backend/scripts/.env.prod` (local only, never committed).

## Verification cadence
- Quarterly: restore-test PITR to a scratch server, run `SELECT count(*) FROM tickets`, delete.
- The in-app snapshot list doubles as the freshness monitor (Settings header shows last-snapshot age).
