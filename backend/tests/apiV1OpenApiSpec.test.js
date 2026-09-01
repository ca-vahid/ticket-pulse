// FR 08-05 #1 (Phase 1c) — the OpenAPI spec + docs page document the intake
// enrichment surface: create/update schema fields, the create response's
// intake-transparency meta, the /custom-fields path, worked validation-error
// examples, and the docs page's enrichment + Power Platform sender sections.
// Cheap shape assertions — the spec is hand-maintained, so this pins the
// documented contract to what the routes actually implement.

import { buildOpenApiSpec, renderDocsPage } from '../src/routes/apiV1.openapi.js';

const spec = buildOpenApiSpec('https://tp.example');
const schemas = spec.components.schemas;

describe('OpenAPI spec — intake enrichment (FR 08-05 Phase 1c)', () => {
  test('CreateTicket documents the enrichment fields with descriptions', () => {
    const props = schemas.CreateTicket.properties;
    for (const field of ['category', 'subcategory', 'customFields', 'ccEmails', 'source', 'ticketType']) {
      expect(props[field]).toBeDefined();
      expect(props[field].description).toEqual(expect.any(String));
    }
    expect(props.category.description).toMatch(/case-insensitively/i);
    expect(props.customFields.description).toMatch(/auto-provision/i);
    expect(props.customFields.description).toMatch(/customfields:write/);
    // Caps are stated where senders will read them.
    expect(props.customFields.description).toMatch(/40 keys/);
    expect(props.customFields.description).toMatch(/200 definitions/);
  });

  test('CreateTicket documents group placement (QA 08-06 #1)', () => {
    const props = schemas.CreateTicket.properties;
    expect(props.groupId).toEqual(expect.objectContaining({ type: 'integer' }));
    expect(props.internalGroupId).toEqual(expect.objectContaining({ type: 'integer' }));
    expect(props.groupId.description).toMatch(/default internal group/i);
    expect(props.internalGroupId.description).toMatch(/default internal group/i);
  });

  test('Ticket (read shape) and UpdateTicket carry customFields + names', () => {
    expect(schemas.Ticket.properties.customFields).toBeDefined();
    const up = schemas.UpdateTicket.properties;
    expect(up.customFields).toBeDefined();
    expect(up.customFields.description).toMatch(/never auto-provision|NO auto-provisioning/i);
    expect(up.category).toBeDefined();
    expect(up.subcategory).toBeDefined();
  });

  test('the create response documents meta.{ignoredFields,rejectedCustomFields,provisionedCustomFields}', () => {
    const schema = spec.paths['/tickets'].post.responses['201'].content['application/json'].schema;
    const meta = schema.properties.meta;
    expect(Object.keys(meta.properties)).toEqual(expect.arrayContaining(['ignoredFields', 'rejectedCustomFields', 'provisionedCustomFields']));
    expect(meta.properties.rejectedCustomFields.items.properties).toHaveProperty('key');
    expect(meta.properties.rejectedCustomFields.items.properties).toHaveProperty('reason');
  });

  // Mega 08-31 Phase PA — the resubmission upsert is part of the documented contract.
  test('externalRef resubmission upsert: CreateTicket field, 200 response, meta keys, PATCH set-once', () => {
    const create = schemas.CreateTicket.properties;
    expect(create.externalRef).toEqual(expect.objectContaining({ type: 'string', maxLength: 200 }));
    expect(create.externalRef.description).toMatch(/resubmitted: true/i);
    expect(create.externalRef.description).toMatch(/Idempotency-Key/);
    expect(create.reopenOnResubmit).toEqual(expect.objectContaining({ type: 'boolean', default: true }));
    expect(create.resubmitStrategy.enum).toEqual(['append', 'replace']);
    expect(schemas.CreateTicket.example.externalRef).toBe('sp-projectrequests-1260');
    expect(schemas.Ticket.properties.externalRef).toEqual(expect.objectContaining({ type: 'string', nullable: true }));
    expect(schemas.UpdateTicket.properties.externalRef.description).toMatch(/SET-ONCE/);

    const post = spec.paths['/tickets'].post;
    expect(post.responses['201']).toBeDefined();
    const ok = post.responses['200'].content['application/json'];
    expect(ok.schema.properties.resubmitted.enum).toEqual([true]);
    expect(ok.example.resubmitted).toBe(true);
    expect(ok.example.meta.matchedBy).toBe('external_ref');

    const meta = post.responses['201'].content['application/json'].schema.properties.meta.properties;
    for (const key of ['resubmitted', 'changedFields', 'reopened', 'matchedBy', 'resubmissionAmbiguous', 'priorExternalRefTicket', 'aiRetriage']) {
      expect(meta[key]).toBeDefined();
    }
    expect(meta.matchedBy.enum).toEqual(['external_ref', 'custom_field_key', 'subject_heuristic']);
  });

  test('validation-error examples: 400 with allowed values on create, 422 unknown_custom_fields on PATCH', () => {
    const create400 = spec.paths['/tickets'].post.responses['400'];
    expect(create400.content['application/problem+json'].example.detail).toMatch(/Allowed categories/);
    const patch = spec.paths['/tickets/{id}'].patch;
    const patch422 = patch.responses['422'];
    expect(patch422.content['application/problem+json'].example.code).toBe('unknown_custom_fields');
    expect(patch422.content['application/problem+json'].example.errors[0].code).toBe('unknown_field');
  });

  test('the /custom-fields path is documented with its scope and definition schema', () => {
    const get = spec.paths['/custom-fields'].get;
    expect(get['x-required-scope']).toBe('customfields:read');
    const data = get.responses['200'].content['application/json'].schema.properties.data;
    expect(data.items.$ref).toBe('#/components/schemas/CustomFieldDefinition');
    expect(schemas.CustomFieldDefinition.properties.source.enum).toEqual(['manual', 'api']);
  });
});

describe('docs page — sender guide sections', () => {
  const html = renderDocsPage('https://tp.example');

  test('ticket intake enrichment section: field table, validation rules, semantics, QA sample', () => {
    expect(html).toContain('Ticket intake enrichment');
    expect(html).toContain('Category validation');
    expect(html).toContain('Custom fields — semantics');
    // QA's Coyote Landslide sample payload, verbatim fields.
    for (const bit of ['Coyote Landslide', 'Project Setup', 'Quebec', 'ACME Inc', '1260',
      'sharePointItemLink', 'powerAppFormLink', 'sourceSystem', 'sourceRequestType']) {
      expect(html).toContain(bit);
    }
    // Response transparency + snake_case echo are shown.
    expect(html).toContain('provisionedCustomFields');
    expect(html).toContain('share_point_item_link');
  });

  test('Power Apps / Power Automate section: HTTP config, idempotency, problem parsing, connector caveat', () => {
    expect(html).toContain('Calling from Power Apps / Power Automate');
    expect(html).toContain('Authorization: Bearer tp_live_');
    // Two keys, two jobs (Phase PA): Idempotency-Key per RUN, externalRef per RECORD.
    expect(html).toContain("workflow()?['run']?['name']");
    expect(html).toContain("concat('sp-projectrequests-', triggerOutputs()?['body/ID'])");
    expect(html).toContain('Resubmissions');
    expect(html).toContain('resubmitted: true');
    expect(html).toMatch(/Do not key it per record/);
    expect(html).not.toContain("concat('sp-', triggerOutputs()?['body/ID'])");
    expect(html).toContain('Secure Inputs');
    expect(html).toMatch(/HTTP connector is Premium/);
    expect(html).toContain('request_id');
    // Custom-connector reality: the wizard needs Swagger 2.0, not our 3.1.
    expect(html).toContain('OpenAPI 2.0');
    expect(html).toContain('including the “Bearer ” prefix');
  });

  test('the docs page stays self-contained (no external assets)', () => {
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+href="http/);
  });
});

// Phase 2 — cf_* list filters are part of the documented contract.
describe('OpenAPI spec + docs — cf_* list filters (Phase 2)', () => {
  test('GET /tickets documents the cf_{key} / _gte / _lte query params', () => {
    const params = spec.paths['/tickets'].get.parameters || [];
    const names = params.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(['cf_{key}', 'cf_{key}_gte', 'cf_{key}_lte']));
    const eq = params.find((p) => p.name === 'cf_{key}');
    expect(eq.in).toBe('query');
    expect(eq.description).toMatch(/contains/i);
    expect(eq.description).toMatch(/ignored/i);
  });

  test('the docs page carries the filtering one-liner', () => {
    const page = renderDocsPage('https://tp.example');
    expect(page).toContain('cf_&lt;key&gt;');
    expect(page).toMatch(/case-insensitive contains/);
  });
});
