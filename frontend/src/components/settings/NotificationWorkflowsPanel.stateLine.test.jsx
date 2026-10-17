/** @vitest-environment jsdom */
// eslint-disable-next-line no-unused-vars
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

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

vi.mock('@tiptap/starter-kit', () => ({
  default: {},
}));

vi.mock('react-resizable-panels', () => ({
  Group: ({ children }) => <div>{children}</div>,
  Panel: ({ children }) => <div>{children}</div>,
  Separator: () => <div />,
  useDefaultLayout: () => ({
    defaultLayout: undefined,
    onLayoutChanged: vi.fn(),
  }),
}));

vi.mock('../../services/api', () => ({
  notificationWorkflowAPI: {},
}));

const { WorkflowStateLine, workflowRunState, workflowStateSteps, EmailBlockPreview, emailBlockPreviewDocument } = await import('./NotificationWorkflowsPanel');

afterEach(cleanup);

const wf = (isEnabled, mockModeEnabled) => ({ id: 7, name: 'After-hours reply', isEnabled, mockModeEnabled, publishedVersion: 3 });

describe('workflow state: Off · Shadow · Live (QA 10-16)', () => {
  test('the two stored flags read as one word; Shadow without Live is Off', () => {
    expect(workflowRunState(wf(false, false))).toBe('off');
    expect(workflowRunState(wf(false, true))).toBe('off');
    expect(workflowRunState(wf(true, true))).toBe('shadow');
    expect(workflowRunState(wf(true, false))).toBe('live');
  });

  test('Off to Shadow turns Shadow on before the workflow, so it is never live for a moment', () => {
    expect(workflowStateSteps(wf(false, false), 'shadow')).toEqual([['shadow', true], ['enabled', true]]);
    expect(workflowStateSteps(wf(false, true), 'shadow')).toEqual([['enabled', true]]);
    expect(workflowStateSteps(wf(true, false), 'shadow')).toEqual([['shadow', true]]);
  });

  test('Live clears Shadow first; Off only switches the workflow off', () => {
    expect(workflowStateSteps(wf(false, true), 'live')).toEqual([['shadow', false], ['enabled', true]]);
    expect(workflowStateSteps(wf(true, true), 'live')).toEqual([['shadow', false]]);
    expect(workflowStateSteps(wf(true, true), 'off')).toEqual([['enabled', false]]);
    expect(workflowStateSteps(wf(false, true), 'off')).toEqual([]);
  });

  test('the header says Off for the confusing "Shadow on, Live off" case, and the menu offers three choices', () => {
    const onSetState = vi.fn();
    render(<WorkflowStateLine workflow={wf(false, true)} published saving={false} onSetState={onSetState} />);
    const line = screen.getByTestId('workflow-state-line');
    expect(line).toHaveTextContent('Off');
    expect(line).not.toHaveTextContent('Shadow');
    fireEvent.click(line);
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual(['Off', 'Shadow', 'Live']);
    expect(screen.getByRole('radio', { name: 'Off' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('radio', { name: 'Shadow' }));
    expect(onSetState).toHaveBeenCalledWith('shadow');
  });

  test('a Shadow workflow reads Shadow; a draft cannot be put in Shadow or Live', () => {
    render(<WorkflowStateLine workflow={wf(true, true)} published saving={false} onSetState={vi.fn()} />);
    expect(screen.getByTestId('workflow-state-line')).toHaveTextContent('Shadow');
    cleanup();
    render(<WorkflowStateLine workflow={{ ...wf(false, false), publishedVersion: 0 }} published={false} saving={false} onSetState={vi.fn()} />);
    expect(screen.getByTestId('workflow-state-line')).toHaveTextContent('Draft');
    fireEvent.click(screen.getByTestId('workflow-state-line'));
    expect(screen.getByRole('radio', { name: 'Shadow' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Live' })).toBeDisabled();
  });
});

describe('e-mail branding preview (QA 10-16: the footer looked stretched)', () => {
  const footer = '<table style="width:400pt"><tr><td><img alt="Logo" height="90" style="height:90px;width:auto" src="https://example.com/logo.png" /></td><td style="width:309pt">IT Helpdesk</td></tr></table><script>alert(1)</script>';

  test('renders in its own document with mail-client defaults and no scripts', () => {
    const doc = emailBlockPreviewDocument(footer);
    expect(doc).toMatch(/^<!doctype html>/);
    expect(doc).toContain('font-family:Calibri');
    expect(doc).toContain('height:90px;width:auto');
    expect(doc).not.toContain('<script');
  });

  test('is a frame (app styles cannot squeeze the logo) that cannot run scripts', () => {
    render(<EmailBlockPreview html={footer} title="AUS footer preview" />);
    const frame = screen.getByTitle('AUS footer preview');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('sandbox')).toBe('allow-same-origin');
    expect(frame.getAttribute('srcdoc')).toContain('IT Helpdesk');
  });
});
