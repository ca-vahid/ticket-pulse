import { readFileSync } from 'node:fs';

/** Where the relation webhooks and the workflow roll-up skip are wired (Phase B-2). */
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

describe('relation webhooks', () => {
  test('links, parent changes, merge and split each emit exactly where the history row is written', () => {
    const links = read('../src/services/ticketLinkService.js');
    expect(links.match(/_emitRelation\(workspaceId, 'ticket\.linked'/g)).toHaveLength(2); // linked + unlinked
    expect(links.match(/_emitRelation\(workspaceId, 'ticket\.parent_changed'/g)).toHaveLength(2); // set + removed
    expect(read('../src/services/ticketMergeService.js')).toContain("dispatchWebhookEvent(workspaceId, 'ticket.merged'");
    expect(read('../src/services/ticketSplitService.js')).toContain("dispatchWebhookEvent(workspaceId, 'ticket.split'");
  });

  test('the mirror sweep pulls FreshService-side task completion back (B5)', () => {
    expect(read('../src/services/mirrorService.js')).toContain('ticketTaskService._syncMirroredStatusFromFs(ticket)');
    const tasks = read('../src/services/ticketTaskService.js');
    expect(tasks).toContain("this._emitTaskEvent('task.completed', ticket, row, { name: 'FreshService', role: 'system' }, { via: 'freshservice' })");
  });

  test('a create-or-return hit answers 200, a fresh task 201', () => {
    expect(read('../src/routes/apiV1.routes.js')).toContain("res.status(task?.existing ? 200 : 201)");
  });
});

describe('the benign-resolve workflow leaves a parent with open children open', () => {
  const engine = read('../src/services/notificationWorkflowEngine.js');
  test('update_ticket checks open children before a terminal status and reports the skip', () => {
    expect(engine).toContain('ticketRollUpService.openChildrenOf(ticket.id, ticket.workspaceId)');
    expect(engine).toContain("rollUpSkip = { status: setStatus, reason: `left open —");
    expect(engine).toContain('...(rollUpSkip ? { rollUpSkip } : {}),');
    // The skip only nulls the status; every other change on the node still applies.
    expect(engine).toContain('if (rollUpSkip) {\n    setStatus = null;\n  }');
  });
});
