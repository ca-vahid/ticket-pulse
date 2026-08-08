/** @vitest-environment jsdom */
// eslint-disable-next-line no-unused-vars
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, test, vi } from 'vitest';

// QA 08-07 #1 — "Apply to workflow resets my HTML": TipTap StarterKit strips
// table/div/span/img/a/style on round-trip, and the save/preview snapshot used
// to take editor.getHTML() unconditionally. These guards keep advanced HTML
// out of the rich editor entirely and only trust getHTML() after a real,
// rich-tab user edit.

vi.mock('@monaco-editor/react', () => ({
  default: () => <div data-testid="monaco-editor" />,
}));
vi.mock('@xyflow/react', () => ({
  Background: () => null,
  Controls: () => null,
  ReactFlow: ({ children }) => <div data-testid="react-flow">{children}</div>,
}));
vi.mock('@tiptap/react', () => ({
  EditorContent: () => null,
  useEditor: () => null,
}));
vi.mock('@tiptap/starter-kit', () => ({ default: {} }));
vi.mock('../../services/api', () => ({
  notificationWorkflowAPI: {},
  ticketsAPI: {},
}));

const {
  templateHtmlIsAdvanced,
  shouldTakeRichEditorHtml,
  validateWorkflowDefinitionClient,
} = await import('./NotificationWorkflowsPanel.jsx');

describe('templateHtmlIsAdvanced (beyond-StarterKit detection)', () => {
  test.each([
    ['table layout', '<table><tr><td>Hi {{ requester.name }}</td></tr></table>'],
    ['div wrapper', '<div class="wrapper"><p>Hello</p></div>'],
    ['span styling', '<p><span class="brand">Ticket Pulse</span></p>'],
    ['image', '<p><img src="https://cdn.example.com/logo.png" alt="logo"></p>'],
    ['anchor', '<p><a href="https://example.com">Open the portal</a></p>'],
    ['inline style attribute', '<p style="color:#2563eb">Branded paragraph</p>'],
    ['uppercase tags', '<TABLE><TR><TD>legacy mailer</TD></TR></TABLE>'],
  ])('detects %s', (_label, html) => {
    expect(templateHtmlIsAdvanced(html)).toBe(true);
  });

  test.each([
    ['plain paragraphs', '<p>Your ticket <strong>#{{ ticket.freshserviceTicketId }}</strong> was resolved.</p>'],
    ['headings, lists, quotes', '<h2>Summary</h2><ul><li>One</li></ul><blockquote><p>quote</p></blockquote>'],
    ['empty content', ''],
    ['null/undefined', null],
    // "a" only matches as a TAG, not inside words; "style" only as an attribute.
    ['words containing a/style', '<p>a stylish avocado ate an apple</p>'],
  ])('simple StarterKit content is NOT advanced (%s)', (_label, html) => {
    expect(templateHtmlIsAdvanced(html)).toBe(false);
  });
});

describe('shouldTakeRichEditorHtml (save/preview snapshot gating)', () => {
  const base = {
    nodeType: 'template_render',
    templateTab: 'rich',
    dirty: true,
    nodeHtml: '<p>simple</p>',
  };

  test('takes getHTML() only for a dirty rich-tab template node with simple HTML', () => {
    expect(shouldTakeRichEditorHtml(base)).toBe(true);
  });

  test('never when the editor is not dirty (the Monaco-apply clobber path)', () => {
    expect(shouldTakeRichEditorHtml({ ...base, dirty: false })).toBe(false);
  });

  test('never from another tab (source/text/preview edits own node data directly)', () => {
    expect(shouldTakeRichEditorHtml({ ...base, templateTab: 'source' })).toBe(false);
    expect(shouldTakeRichEditorHtml({ ...base, templateTab: 'preview' })).toBe(false);
  });

  test('never when the node holds advanced HTML (rich tab shows the notice card instead)', () => {
    expect(shouldTakeRichEditorHtml({
      ...base,
      nodeHtml: '<table style="width:100%"><tr><td>branded</td></tr></table>',
    })).toBe(false);
  });

  test('never for non-template nodes', () => {
    expect(shouldTakeRichEditorHtml({ ...base, nodeType: 'llm_generate' })).toBe(false);
  });
});

// Rider found while installing the new location_subcategory_router template:
// the client validator only knew the static 'otherwise' handle, so branch
// edges keyed on user-defined branch keys were flagged "invalid branch output
// handle" (the backend accepted them). Handles must come from node data.
describe('validateWorkflowDefinitionClient branch handles', () => {
  function branchDefinition() {
    return {
      version: 2,
      metadata: {},
      nodes: [
        { id: 'trigger', type: 'trigger', data: { triggerType: 'ticket.created' } },
        {
          id: 'route',
          type: 'branch',
          data: {
            branches: [
              { key: 'quebec', label: 'Quebec', conditionGroup: { logic: 'all', conditions: [{ field: 'custom:client_location', operator: 'contains', value: 'Quebec' }] } },
              { key: 'chile', label: 'Chile', conditionGroup: { logic: 'all', conditions: [{ field: 'custom:client_location', operator: 'contains', value: 'Chile' }] } },
            ],
          },
        },
        { id: 'set-quebec', type: 'update_ticket', data: { setSubcategoryName: 'Quebec' } },
        { id: 'set-chile', type: 'update_ticket', data: { setSubcategoryName: 'Chile' } },
        { id: 'set-other', type: 'update_ticket', data: { setSubcategoryName: 'Other' } },
        { id: 'end', type: 'stop', data: {} },
      ],
      edges: [
        { id: 'e1', source: 'trigger', target: 'route' },
        { id: 'e2', source: 'route', sourceHandle: 'quebec', target: 'set-quebec' },
        { id: 'e3', source: 'route', sourceHandle: 'chile', target: 'set-chile' },
        { id: 'e4', source: 'route', sourceHandle: 'otherwise', target: 'set-other' },
        { id: 'e5', source: 'set-quebec', target: 'end' },
        { id: 'e6', source: 'set-chile', target: 'end' },
        { id: 'e7', source: 'set-other', target: 'end' },
      ],
    };
  }

  test('edges on configured branch keys (and otherwise) validate clean', () => {
    expect(validateWorkflowDefinitionClient(branchDefinition(), 'ticket.created')).toEqual([]);
  });

  test('an edge on a key the branch does not define is still rejected', () => {
    const definition = branchDefinition();
    definition.edges[1].sourceHandle = 'atlantis';
    expect(validateWorkflowDefinitionClient(definition, 'ticket.created')).toEqual(expect.arrayContaining([
      expect.stringContaining('invalid branch output handle'),
    ]));
  });
});
