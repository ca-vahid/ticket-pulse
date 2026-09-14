import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { noteStageMeta, stagedActorName, NOTE_STAGES } from '../src/services/ticketService.js';
import { WEBHOOK_EVENTS } from '../src/services/webhookDispatchService.js';
import { buildOpenApiSpec } from '../src/routes/apiV1.openapi.js';

/**
 * Simorgh Release C — stage-as-data (A5), the private-note webhook (D2),
 * reconciliation filters (E2) and the audit read (E3).
 *
 * The stage field is the licence-free answer to "two credentials": one
 * client, and the note says which stage of it is talking.
 */

const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('A5 — stage as data on a note', () => {
  test('tier1 / tier2 / tier3 are the stages; anything else is dropped, the agent name kept', () => {
    expect(NOTE_STAGES).toEqual(['tier1', 'tier2', 'tier3']);
    expect(noteStageMeta({ stage: 'tier2', agent: 'Rostam' })).toEqual({ stage: 'tier2', agent: 'Rostam' });
    expect(noteStageMeta({ stage: 'TIER2' })).toEqual({ stage: 'tier2', agent: null });
    expect(noteStageMeta({ stage: 'boss', agent: 'Rostam' })).toEqual({ stage: null, agent: 'Rostam' });
    expect(noteStageMeta({ stage: 'boss' })).toBeNull();
    expect(noteStageMeta({})).toBeNull();
    expect(noteStageMeta(null)).toBeNull();
  });

  test('the agent name is a display string, trimmed and capped', () => {
    expect(noteStageMeta({ agent: '  Rostam  ' })).toEqual({ stage: null, agent: 'Rostam' });
    expect(noteStageMeta({ agent: 'x'.repeat(200) }).agent).toHaveLength(60);
  });

  test('renders the author the way the thread will show it', () => {
    expect(stagedActorName('Simorgh', { stage: 'tier2', agent: 'Rostam' })).toBe('Simorgh · Tier 2 (Rostam)');
    expect(stagedActorName('Simorgh', { stage: 'tier1', agent: null })).toBe('Simorgh · Tier 1');
    expect(stagedActorName('Simorgh', { stage: null, agent: 'Rostam' })).toBe('Simorgh (Rostam)');
  });

  test('the note route accepts stage/agent, the entry stores them, the conversation returns them', () => {
    const api = src('../src/routes/apiV1.routes.js');
    const svc = src('../src/services/ticketService.js');
    expect(api).toMatch(/stage: req\.body\?\.stage \?\? null,\s*agent: req\.body\?\.agent \?\? null,/);
    expect(api).toMatch(/stage: e\.rawPayload\?\.stage \|\| null,\s*agent: e\.rawPayload\?\.agent \|\| null,/);
    expect(svc).toMatch(/actorName: stageMeta \? stagedActorName\(baseActorName, stageMeta\) : baseActorName/);
    expect(svc).toMatch(/rawPayload: \{ \.\.\.\(recipients \|\| \{\}\), \.\.\.\(stageMeta \|\| \{\}\) \}/);
  });
});

describe('D2 — ticket.note_added reaches webhooks with the note itself', () => {
  test('is in the outbound allow-list', () => {
    expect(WEBHOOK_EVENTS).toContain('ticket.note_added');
  });

  test('the event extra carries author, stage, agent and the body text', () => {
    const svc = src('../src/services/ticketService.js');
    const emit = svc.slice(svc.indexOf("isPrivate ? 'ticket.note_added' : 'ticket.public_reply_added'"));
    for (const key of ['ref:', 'author:', 'authorType:', 'isPrivate,', 'stage:', 'agent:', 'bodyText:', 'occurredAt:']) {
      expect(emit.slice(0, 1600)).toContain(key);
    }
  });

  test('the Settings picker offers it', () => {
    const panel = src('../../frontend/src/components/settings/ApiKeysPanel.jsx');
    expect(panel).toMatch(/\['ticket\.note_added', 'Private note added'\]/);
  });
});

describe('E2 — reconciliation filters on GET /tickets', () => {
  const svc = src('../src/services/ticketService.js');

  test('externalRef exact wins over externalRefPrefix', () => {
    expect(svc).toMatch(/if \(query\.externalRef\) \{\s*where\.externalRef = String\(query\.externalRef\)\.trim\(\);\s*\} else if \(query\.externalRefPrefix\)/);
  });

  test('updatedFrom / updatedTo become an updatedAt range and an unparseable date is ignored, not fatal', () => {
    expect(svc).toMatch(/where\.updatedAt = \{[\s\S]{0,200}gte: from[\s\S]{0,120}lte: to/);
    expect(svc).toMatch(/if \(Object\.keys\(where\.updatedAt\)\.length === 0\) delete where\.updatedAt;/);
  });

  test('tag filters by tag NAME through the link table', () => {
    expect(svc).toMatch(/where\.tagLinks = \{ some: \{ tag: \{ name: \{ in: names \} \} \} \}/);
  });

  test('all five are documented on the list operation', () => {
    const spec = buildOpenApiSpec();
    const names = spec.paths['/tickets'].get.parameters.map((p) => p.name);
    for (const n of ['externalRef', 'externalRefPrefix', 'updatedFrom', 'updatedTo', 'tag']) expect(names).toContain(n);
  });
});

describe('E3 — GET /tickets/{id}/activities', () => {
  test('exists, read scope, capped limit, and is documented', () => {
    const api = src('../src/routes/apiV1.routes.js');
    expect(api).toMatch(/router\.get\('\/tickets\/:id\/activities', S\('tickets:read'\)/);
    expect(api).toMatch(/Math\.min\(Number\(req\.query\.limit\) \|\| 100, 500\)/);
    const spec = buildOpenApiSpec();
    expect(spec.paths['/tickets/{id}/activities'].get['x-required-scope']).toBe('tickets:read');
  });
});

describe('OpenAPI — the Message schema knows about stage and agent', () => {
  test('stage is an enum, agent is capped', () => {
    const spec = buildOpenApiSpec();
    const msg = spec.components.schemas.Message;
    expect(msg.properties.stage.enum).toEqual(['tier1', 'tier2', 'tier3']);
    expect(msg.properties.agent.maxLength).toBe(60);
  });
});
