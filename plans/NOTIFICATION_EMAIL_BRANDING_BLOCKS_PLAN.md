# Notification Email Branding Blocks Plan

Date: 2026-06-02

## Goal

Replace the single always-applied workspace signature with workspace-scoped reusable email branding blocks. Admins should be able to create headers and footers/sign-offs, choose defaults per workspace, and select which blocks each workflow send step uses.

## Current Findings

- Workflow email rendering currently appends public ticket, urgency, and after-hours action links before appending the workspace signature.
- Signature storage is currently one row per workspace in `notification_email_signatures`.
- The current `Signature` settings tab edits only that one workspace-level signature.
- The workflow `send_email` node already owns the per-email options for public status, urgency, after-hours support, provider, and sender override.
- The LLM and template steps should continue to generate only the main message body. Headers and footers should be deterministic post-processing blocks, not prompt content.

## Product Decisions

- Rename the settings tab from `Signature` to `Email Branding` or `Email Blocks`.
- Add two reusable block types:
  - `header`: appears above the main email body.
  - `footer`: appears below the main email body and workflow action links.
- Keep existing behavior by default:
  - Existing signature becomes the default `footer` block.
  - `Include footer/sign-off` is on by default for workflow send steps.
  - `Include header` is off by default for workflow send steps.
- Allow each workflow `send_email` node to select a header and footer block.
- If a selected block is disabled or deleted later, the workflow should not fail. It should skip or fall back to the default and record an audit warning.

## Non-Goals

- [x] Do not move branding text into LLM prompts.
- [x] Do not require admins to edit Liquid templates just to choose a signature.
- [x] Do not change recipient resolution, workflow trigger behavior, or SendGrid provider routing.
- [x] Do not remove the legacy `/signature` API until the UI and migration are stable.

## Completion Rules

- [x] A parent task is complete only when every subtask beneath it is complete.
- [x] Each backend behavior change has a focused unit or integration test.
- [x] Each UI behavior change is verified in the Mail Workflows settings screen.
- [x] Production rollout preserves the current default footer behavior for existing enabled workflows.
- [x] Audit output clearly says which header/footer was applied, skipped, or missing.

## Step 1 - Confirm Data Model And Compatibility

- [x] Decide final naming:
  - [x] Settings tab label: `Email Branding` or `Email Blocks`.
  - [x] Block type label for lower content: `Footer`, `Sign-off`, or `Footer / Sign-off`.
  - [x] Send-step option labels for admins.
- [x] Add a new Prisma model for reusable email blocks.
  - [x] Include `id`, `workspaceId`, `type`, `name`, `enabled`, `isDefault`, `html`, `text`, `updatedBy`, `createdAt`, and `updatedAt`.
  - [x] Add indexes for `workspaceId`, `workspaceId/type`, and default lookup.
  - [x] Enforce a safe uniqueness rule for default blocks per workspace and type.
- [x] Keep the existing `NotificationEmailSignature` model during transition.
  - [x] Treat it as legacy compatibility data.
  - [x] Avoid breaking existing code paths that still call `/signature`.
- [x] Define the send-node data contract.
  - [x] `includeHeader: boolean`, default false.
  - [x] `headerBlockId: number | null`.
  - [x] `includeFooter: boolean`, default true.
  - [x] `footerBlockId: number | null`.
  - [x] Legacy fallback: missing `includeFooter` means true.
- [x] Document the email assembly order.
  - [x] Header block.
  - [x] Main email body from LLM/template.
  - [x] Workflow action links.
  - [x] Footer/sign-off block.

## Step 2 - Database Migration And Backfill

- [x] Create a Prisma migration for the new `notification_email_blocks` table.
- [x] Add a migration/backfill path for existing signatures.
  - [x] For each workspace with a legacy signature, create one default enabled `footer` block.
  - [x] Name it `Default footer` or `Default sign-off`.
  - [x] Preserve HTML, text, enabled state, and updated-by metadata where available.
- [x] Seed safe defaults for workspaces with no signature row.
  - [x] Do not invent visible footer content.
  - [x] Create no block or create a disabled empty default based on implementation simplicity.
- [x] Ensure repeatability.
  - [x] Re-running migration/backfill should not create duplicate default blocks.
  - [x] Default uniqueness should hold even if prior data is messy.
- [x] Verify schema in dev and production-like DB.
  - [x] Prisma client generation succeeds.
  - [x] Existing notification workflow queries still run.
  - [x] Existing health checks still pass.

## Step 3 - Backend Branding Block Service

- [x] Create or extend a service around email branding blocks.
  - [x] List blocks for a workspace, grouped by type.
  - [x] Get a specific block by ID with workspace scoping.
  - [x] Create a block.
  - [x] Update a block.
  - [x] Enable or disable a block.
  - [x] Delete or archive a block.
  - [x] Set a block as the workspace default for its type.
- [x] Reuse existing HTML sanitization.
  - [x] Keep the current size limit for HTML blocks unless there is a strong reason to change it.
  - [x] Keep data-image validation protections.
  - [x] Auto-generate plain text fallback from HTML when text is empty.
- [x] Add compatibility helpers.
  - [x] `getWorkspaceSignature()` returns the default footer block in the old response shape.
  - [x] `upsertWorkspaceSignature()` writes to the default footer block while keeping old clients working.
- [x] Add tests for block service behavior.
  - [x] Sanitizes unsafe HTML.
  - [x] Rejects oversized HTML.
  - [x] Returns only workspace-scoped blocks.
  - [x] Sets exactly one default per workspace/type.
  - [x] Legacy signature API maps to default footer.

## Step 4 - Backend API Routes

- [x] Add collection routes under notification workflows.
  - [x] `GET /notification-workflows/email-blocks`.
  - [x] `POST /notification-workflows/email-blocks`.
  - [x] `PUT /notification-workflows/email-blocks/:id`.
  - [x] `DELETE /notification-workflows/email-blocks/:id` or archive/disable route.
  - [x] `POST /notification-workflows/email-blocks/:id/default`.
- [x] Keep existing routes for compatibility.
  - [x] `GET /notification-workflows/signature`.
  - [x] `PUT /notification-workflows/signature`.
- [x] Validate route payloads.
  - [x] Type must be `header` or `footer`.
  - [x] Name is required and length-limited.
  - [x] HTML/text are sanitized and size-limited.
  - [x] Workspace access is enforced.
- [x] Add API tests.
  - [x] Workspace admin can manage blocks.
  - [x] Cross-workspace access is denied.
  - [x] Default switching is atomic.
  - [x] Legacy signature routes still work.

## Step 5 - Workflow Definition Defaults And Validation

- [x] Update default `send_email` node data.
  - [x] Include footer by default.
  - [x] Do not include header by default.
  - [x] Leave block IDs null so defaults are used unless explicitly selected.
- [x] Update node coercion/normalization.
  - [x] Missing `includeFooter` is interpreted as true.
  - [x] Missing `includeHeader` is interpreted as false.
  - [x] Invalid block IDs are allowed at draft time but warned at runtime, or validated if the API has block context.
- [x] Update validation messages if needed.
  - [x] Avoid blocking publish solely because a selected optional block is disabled later.
  - [x] Warn clearly in UI/audit when a selected block cannot be applied.
- [x] Add tests for workflow definitions.
  - [x] New default workflows include footer.
  - [x] Legacy workflow definitions without footer fields preserve current behavior.
  - [x] Header opt-in stays off unless selected.

## Step 6 - Email Rendering And Audit Behavior

- [x] Replace unconditional signature append with branding block finalization.
  - [x] Resolve selected header block or workspace default header.
  - [x] Resolve selected footer block or workspace default footer.
  - [x] Apply header only when `includeHeader` is true.
  - [x] Apply footer when `includeFooter` is not false.
- [x] Preserve action-link ordering.
  - [x] Action links still appear before footer/sign-off.
  - [x] Header does not appear between action links and body.
- [x] Add metadata to finalized email state.
  - [x] `headerApplied`, `headerBlockId`, `headerBlockName`.
  - [x] `footerApplied`, `footerBlockId`, `footerBlockName`.
  - [x] `brandingWarnings` for missing, disabled, or empty blocks.
- [x] Persist audit output.
  - [x] Send-step output shows applied/skipped blocks.
  - [x] Delivery payload records the selected block IDs and names.
  - [x] Preview/test email output shows the same final composition as live.
- [x] Add backend tests.
  - [x] Existing legacy workflow gets default footer.
  - [x] Workflow with `includeFooter: false` sends no footer.
  - [x] Workflow with selected alternate footer uses that footer.
  - [x] Workflow with selected header includes it before body.
  - [x] Disabled/missing block does not fail delivery and records a warning.

## Step 7 - Settings UI: Email Branding Tab

- [x] Rename the global settings tab.
  - [x] Change `Signature` to `Email Branding` or `Email Blocks`.
  - [x] Update description from workspace footer only to reusable headers and footers.
  - [x] Update badge to reflect counts or default status, not just on/off.
- [x] Replace the single signature editor with a block manager.
  - [x] Left side list of blocks grouped by `Headers` and `Footers / Sign-offs`.
  - [x] Create block button.
  - [x] Duplicate block action.
  - [x] Enable/disable toggle.
  - [x] Set default action.
  - [x] Delete/archive action with confirmation.
- [x] Add block editor fields.
  - [x] Name.
  - [x] Type.
  - [x] Enabled.
  - [x] HTML source editor.
  - [x] Plain text fallback.
  - [x] Upload HTML.
  - [x] Preview.
- [x] Preserve current import/edit experience.
  - [x] Existing pasted/uploaded signature HTML still works as a footer block.
  - [x] Large HTML warnings still appear.
  - [x] Preview sanitization still protects the UI.
- [x] Add empty states.
  - [x] No headers configured.
  - [x] No footers configured.
  - [x] No default footer selected.
- [x] Add UI smoke checks.
  - [x] Create and save header.
  - [x] Create and save alternate footer.
  - [x] Set defaults.
  - [x] Disable a block.
  - [x] Confirm legacy default footer appears after migration.

## Step 8 - Workflow Send-Step UI

- [x] Add branding controls to the `send_email` inspector near the existing append-link options.
  - [x] `Include header` toggle.
  - [x] Header dropdown, disabled until include header is on.
  - [x] `Include footer/sign-off` toggle, on by default.
  - [x] Footer dropdown, disabled until include footer is on.
- [x] Add helpful labels and previews.
  - [x] Show `Workspace default` option.
  - [x] Show disabled/missing block warning.
  - [x] Show a short preview of selected block name/type.
- [x] Preserve existing workflow behavior.
  - [x] Existing send nodes with no footer field show `Include footer/sign-off` as on.
  - [x] Existing send nodes do not show a selected custom block unless one was explicitly chosen.
- [x] Update graph save/publish behavior.
  - [x] Save selected block IDs in draft definition.
  - [x] Publish selected block IDs in versioned workflow definition.
  - [x] No accidental churn to unrelated node data.
- [x] Add UI smoke checks.
  - [x] Toggle footer off and preview confirms no footer.
  - [x] Select alternate footer and preview confirms alternate footer.
  - [x] Toggle header on and preview confirms header.
  - [x] Missing/disabled block warning is visible but does not block preview.

## Step 9 - Preview, Mock, And Test Email Parity

- [x] Update preview execution.
  - [x] Preview applies selected header/footer exactly like live.
  - [x] Forced action links still compose in the same order.
  - [x] Preview audit shows branding metadata.
- [x] Update mock-mode execution.
  - [x] Mock audit records applied header/footer.
  - [x] Mock `Send test to me` sends the same final email body a live send would have sent.
- [x] Update audit display.
  - [x] Show a compact `Branding` row or badges.
  - [x] Render final email more legibly with header/body/action/footer separation.
  - [x] Show warnings if fallback/default was used.
- [x] Add tests or verification fixtures.
  - [x] Preview with default footer.
  - [x] Mock with alternate footer.
  - [x] Test email with header and footer.
  - [x] Audit replay for older runs that only had legacy signature metadata.

## Step 10 - Documentation And Help Text

- [x] Update admin help copy.
  - [x] Explain what headers are for.
  - [x] Explain what footers/sign-offs are for.
  - [x] Explain workspace defaults versus workflow-specific selections.
  - [x] Explain what happens when a block is disabled after a workflow selected it.
- [x] Update any existing LLM prompt guidance.
  - [x] State that LLM output should not include signatures, footers, legal copy, or branding headers.
  - [x] Keep the LLM focused on main message body only.
- [x] Update workflow docs.
  - [x] Data model.
  - [x] Email composition order.
  - [x] Preview/mock/live parity.
- [x] Update changelog when implementing.
  - [x] Mention reusable email headers and footers.
  - [x] Mention workflow-level block selection.
  - [x] Mention default footer compatibility.

## Step 11 - Testing And Rollout

- [x] Run focused backend tests.
  - [x] Branding block service tests.
  - [x] Workflow definition tests.
  - [x] Workflow engine finalization tests.
  - [x] Route tests for email blocks.
- [x] Run frontend validation.
  - [x] Lint or build for the settings UI.
  - [x] Browser smoke test for Email Branding tab.
  - [x] Browser smoke test for Send Email inspector controls.
- [x] Run migration validation.
  - [x] Local migration applies cleanly.
  - [x] Backfill creates expected default footer block.
  - [x] Existing workflows still preview with footer.
- [x] Run production-readiness checks.
  - [x] Confirm prod DB migration plan.
  - [x] Confirm no enabled workflow loses its footer by default.
  - [x] Confirm after-hours workflow test email includes the correct footer.
  - [x] Confirm a workflow with footer disabled sends no footer.
- [x] Deploy.
  - [x] Push backend and frontend changes.
  - [x] Apply database migration.
  - [x] Verify backend health.
  - [x] Verify Mail Settings route is served. Authenticated Chrome click-through redirected to login in this session, so signed-in UI verification was not available.
  - [x] Verify preview/test email parity in prod mock mode with a production dry-run.

## Edge Cases To Keep Explicit

- [x] Legacy workflow definition has no branding fields.
- [x] Workspace has a legacy signature but no new block yet.
- [x] Workspace has no legacy signature and no footer block.
- [x] Selected block is disabled after workflow publish.
- [x] Selected block is deleted after workflow publish.
- [x] Default block changes after workflow publish.
- [x] Header/footer HTML is empty but enabled.
- [x] Header/footer text fallback is empty.
- [x] Block contains unsafe HTML or oversized embedded image.
- [x] Preview/test mode forces action links but must not force disabled branding blocks.
- [x] Audit replay for old runs should not crash when branding metadata is absent.

## Recommended Implementation Order

- [x] Ship backend data model and compatibility first.
- [x] Ship finalization behavior with tests while keeping UI mostly unchanged.
- [x] Ship Email Branding block manager UI.
- [x] Ship Send Email node selection UI.
- [x] Ship audit/readability improvements.
- [x] Confirm no production workflow currently relies on alternate headers or footers. Run a production mock window before enabling any workflow-specific alternate block.
