# Notification Workflow Builder Upgrade Plan

Date: 2026-05-31

## Goal

Make notification workflows easier to test and powerful enough for complex live helpdesk routing, including conditions, branching, and multiple LLM calls, without replacing the existing notification workflow engine.

The implementation should keep the current JSON graph model, React Flow canvas, backend execution/audit tables, mock mode, and SendGrid delivery boundary. The first phase is a smaller usability fix for LLM context preview. The second phase upgrades the workflow builder and runtime model.

## Current Baseline

- Backend workflow definitions already support `trigger`, `condition`, `recipient_resolver`, `llm_generate`, `template_render`, `send_email`, and `stop`.
- The engine already branches condition nodes through `true` and `false` source handles.
- The UI currently exposes only a narrow add/select LLM flow, so condition and branching support is mostly hidden from admins.
- LLM output is currently stored as singleton `state.llm` / `state.email`, so multiple LLM nodes need a state-model refactor before they are safe and understandable.
- The existing preview ticket search endpoint already supports FreshService ticket ID, subject, requester, assignee, category, status, and priority search.

## Phase 1: Searchable Ticket Context Picker

### Intent

Replace the raw "Preview ticket ID" field under the LLM Context tab with a searchable ticket picker that uses exposed FreshService ticket numbers and stores the internal Ticket Pulse ID only after selection.

### Backend

- [x] Keep `/api/notification-workflows/preview-tickets` as the shared ticket lookup endpoint.
- [x] Confirm the endpoint searches numeric input against `freshserviceTicketId`.
- [x] Add backend coverage for FreshService ticket number search if it is not already covered.
- [x] Update `/api/notification-workflows/llm-tools/context-preview` to accept either:
  - [x] `ticketId` for the internal Ticket Pulse ID.
  - [x] `freshserviceTicketId` for direct lookup by visible FreshService ticket number.
- [x] Return a clear validation error when neither ID resolves to a ticket in the selected workspace.
- [x] Keep workspace scoping on every lookup.

### Frontend

- [x] Extract the preview modal ticket search UI into a reusable component, likely `TicketContextPicker`.
- [x] Support search by FreshService ticket number, subject, requester, assignee, category, status, and priority.
- [x] Show each result with:
  - [x] FreshService ticket number.
  - [x] Subject.
  - [x] Requester.
  - [x] Assignee if available.
  - [x] Status and priority.
  - [x] Created or updated timestamp.
- [x] Use the picker in the existing workflow preview modal.
- [x] Use the same picker in the LLM Context tab.
- [x] Replace "Internal Ticket Pulse ID" copy with user-facing FreshService ticket wording.
- [x] When a ticket is selected, store `ticket.id` internally for existing APIs.
- [x] Allow manual FreshService ticket number entry as a quick path.
- [x] Show recent current-workspace tickets before the user searches.
- [x] Preserve current LLM context preview and tool-test behavior after ticket selection.

### Phase 1 Tests

- [x] Backend test: `preview-tickets` returns a ticket when searching by FreshService ticket ID.
- [x] Backend test: `context-preview` accepts internal `ticketId`.
- [x] Backend test: `context-preview` accepts `freshserviceTicketId`.
- [x] Backend test: cross-workspace ticket IDs are rejected.
- [x] Frontend test or focused smoke: LLM Context tab can search, select, preview context, and run a tool test.
- [x] Frontend build and lint pass.

### Phase 1 Acceptance Criteria

- [x] Admins no longer need to know internal Ticket Pulse IDs.
- [x] LLM Context preview can be driven from visible FreshService ticket numbers.
- [x] Workflow preview and LLM context preview use one shared ticket picker pattern.

## Phase 2: Advanced Workflow Builder

### Intent

Expose the workflow engine as a real builder: admins can add steps, branch conditions, connect nodes, inspect validation, and eventually run multiple LLM calls in one workflow without hidden state collisions.

### 2.1 Builder Foundation

- [x] Add a shared node registry concept for workflow node types.
- [x] Define each node type with:
  - [x] Type ID.
  - [x] Label.
  - [x] Icon.
  - [x] Default data.
  - [x] Allowed input handles.
  - [x] Allowed output handles.
  - [x] Inspector/editor component.
  - [x] Backend validation schema.
- [x] Start with existing node types:
  - [x] Trigger.
  - [x] Condition.
  - [x] Recipient resolver.
  - [x] LLM generate.
  - [x] Template render.
  - [x] Send email.
  - [x] Stop.
- [x] Keep advanced future nodes out of the first implementation unless the registry makes them cheap:
  - [x] Switch.
  - [x] Set variable.
  - [x] Merge.
  - [x] Tool call.
  - [x] Delay or quiet-hours wait.

### 2.2 Canvas And Editing UX

- [x] Replace "Add LLM" with an "Add step" menu.
- [x] Allow adding:
  - [x] Condition.
  - [x] LLM generate.
  - [x] Template render.
  - [x] Send email.
  - [x] Stop.
- [x] Keep trigger protected from deletion.
- [x] Decide whether recipient/template/send remain required core nodes or become normal removable nodes with validation.
- [x] Add React Flow connection support instead of only fixed predefined edges.
- [x] Validate connections while dragging.
- [x] Show explicit branch labels on condition edges:
  - [x] True.
  - [x] False.
  - [ ] Default, if added later.
- [x] Add a small edge editor for changing condition branch labels where safe.
- [x] Improve auto-layout after adding a node.
- [x] Preserve manual node positioning after admins move nodes.
- [x] Add a validation panel or inline warnings for broken graphs.
- [x] Prevent publishing when graph validation has blocking errors.

### 2.3 Condition Builder

- [x] Keep JSONLogic as the stored backend condition format.
- [x] Add a visual rule builder for common admin cases:
  - [x] Ticket status.
  - [x] Ticket priority or assessed priority.
  - [x] Category/subcategory/internal category.
  - [x] Requester department.
  - [x] Assigned agent exists.
  - [x] Noise ticket flag.
  - [x] After-hours/business-hours state.
  - [x] LLM output fields after multi-LLM support lands.
- [x] Keep raw JSONLogic editing as an advanced mode.
- [x] Show a plain-English preview of each condition.
- [x] Add condition test output in preview runs so admins can see why a branch was taken.

### 2.4 Runtime Validation

- [x] Strengthen `validateWorkflowDefinition`.
- [x] Validate there is exactly one trigger.
- [x] Validate all edge source and target node IDs exist.
- [x] Validate every non-terminal node has a valid outgoing path.
- [x] Validate every reachable path ends in `send_email` or `stop`.
- [x] Validate there are no unreachable nodes, or show them as publish-blocking warnings.
- [x] Detect accidental cycles.
- [x] Either block cycles in v1 or require explicit loop nodes with hard iteration limits.
- [x] Validate condition nodes have `true` and `false` routes.
- [x] Validate send nodes have an upstream recipient resolver.
- [x] Validate send nodes have an upstream template or LLM-generated email source.
- [x] Validate multiple send nodes have stable per-node delivery dedupe keys.
- [x] Keep `MAX_NODE_EXECUTIONS` as a runtime fail-safe.

### 2.5 Multiple LLM Calls

- [x] Refactor runtime state away from singleton `state.llm`.
- [x] Store LLM output per node, for example:
  - [x] `state.outputs[nodeId]`.
  - [x] `state.llmRuns[nodeId]`.
  - [x] `state.email` only for the currently selected final email.
- [x] Add an LLM node output mode:
  - [x] Draft email.
  - [x] Classify or score.
  - [x] Extract structured fields.
  - [x] Critique or guardrail review.
  - [x] Rewrite final email.
- [x] Let each LLM node choose whether to promote its output to the final email.
- [x] Let templates reference specific LLM node outputs.
- [x] Update variable picker to show LLM outputs grouped by node label.
- [x] Update preview/audit UI to show diagnostics for every LLM node, not only the first one.
- [x] Preserve workspace LLM context/tool policy as the global policy.
- [x] Let individual LLM nodes opt out of workspace context/tools only when explicitly configured.

### 2.6 Audit And Preview

- [x] Update preview timeline to show branch decisions clearly.
- [x] Show each node's input, output, duration, and error status.
- [x] Show all LLM diagnostics by node:
  - [x] Provider.
  - [x] Model.
  - [x] Fallback.
  - [x] Token use.
  - [x] Tool calls.
  - [x] Guardrail results.
- [x] Show final selected email source.
- [x] Show all send nodes and whether each would send, skip, mock, or fail.
- [x] Keep mock-mode audit compatible with the richer step output.

### 2.7 Tests

- [x] Backend test: condition true branch runs expected nodes.
- [x] Backend test: condition false branch runs expected nodes.
- [x] Backend test: invalid condition graph blocks publish.
- [x] Backend test: unreachable node blocks publish or returns a clear validation warning.
- [x] Backend test: accidental cycle is blocked or safely capped.
- [x] Backend test: multiple LLM nodes persist separate outputs.
- [x] Backend test: template can reference a specific LLM node output.
- [x] Backend test: multiple send nodes create separate deduped deliveries.
- [x] Backend test: mock mode still suppresses provider delivery with advanced graphs.
- [x] Frontend test or smoke: add a condition, connect true/false paths, preview both branches.
- [x] Frontend test or smoke: add two LLM nodes and inspect both diagnostics.
- [x] Frontend build and lint pass.

### Phase 2 Acceptance Criteria

- [x] Admins can add a condition from the UI without editing JSON manually.
- [x] Admins can build a branched workflow and preview which branch ran.
- [x] Publish is blocked when the graph is structurally unsafe.
- [x] Multiple LLM calls are represented separately in runtime state, preview, and audit.
- [x] Existing simple workflows continue to run unchanged.
- [x] Existing mock mode, preview mode, published versions, and delivery audit remain compatible.

## Recommended Execution Order

- [x] Ship Phase 1 first because it is self-contained and improves testing immediately.
- [x] In Phase 2, build validation and node registry before adding canvas edge editing.
- [x] Add visual condition creation before multiple LLM calls.
- [x] Refactor LLM state before exposing more than one LLM node in the UI.
- [ ] Use mock mode heavily before enabling advanced workflows live.

## Out Of Scope For This Plan

- [ ] Replacing the workflow engine with BPMN or another orchestration system.
- [ ] Letting admins create arbitrary custom code tools from the UI.
- [ ] Letting the LLM send email directly.
- [ ] FreshService ticket updates or public replies from notification workflows.
- [ ] Semantic/vector retrieval for similar tickets.
- [ ] Long-running delayed workflow execution.
