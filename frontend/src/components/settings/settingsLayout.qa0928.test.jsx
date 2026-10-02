/* eslint-env node */
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * QA 09-28 — layout regressions that jsdom cannot measure, pinned at the
 * source: #4 the Settings scroll pane must be the containing block for
 * absolutely positioned descendants (an sr-only checkbox in Ticket Ops sized
 * the page past h-screen), #5 the Mail Workflows Templates panel opens from a
 * button near the LEFT of the toolbar, so it must anchor left.
 */
const read = (p) => readFileSync(resolve(process.cwd(), p), 'utf8');

describe('#4 Settings long sections do not stretch the page', () => {
  const settings = read('src/pages/Settings.jsx');

  test('the <main> scroll pane is relative', () => {
    const main = /<main className="([^"]*)"/.exec(settings)[1].split(/\s+/);
    expect(main).toEqual(expect.arrayContaining(['relative', 'overflow-y-auto']));
  });

  test('the settings nav stretches with the row instead of a fixed viewport calc', () => {
    expect(settings).not.toContain('md:h-[calc(100vh-61px)]');
    expect(settings).toMatch(/tp-glass-strong z-30[^']*md:self-stretch/);
  });

  test('the Ticket Ops group-picker label contains its sr-only checkbox', () => {
    const ops = read('src/components/settings/TicketOpsPanel.jsx');
    const picker = ops.slice(ops.indexOf('data-testid="cgm-group-picker"'));
    const label = picker.slice(picker.indexOf('<label'), picker.indexOf('className="sr-only"'));
    expect(label).toMatch(/className=\{`relative flex/);
  });
});

describe('#5 Workflow templates panel is not clipped (QA 09-28 #5, QA 10-01 #1)', () => {
  const src = read('src/components/settings/NotificationWorkflowsPanel.jsx');

  test('opens toward the side with room and caps its width to the viewport', () => {
    // The button has sat on both sides of the toolbar; a fixed anchor clipped
    // the panel each time (left edge on 09-28, right edge on 10-01).
    const cls = /<div className={`absolute \$\{alignRight \? 'right-0' : 'left-0'\} ([^`]*)`} data-testid="workflow-templates-panel"/.exec(src);
    expect(cls).not.toBeNull();
    expect(cls[1].split(/\s+/)).toEqual(expect.arrayContaining(['z-40', 'w-96', 'max-w-[calc(100vw-5rem)]']));
    expect(src).toContain('setAlignRight(rect.left + 384 > window.innerWidth - 16)');
  });
});
