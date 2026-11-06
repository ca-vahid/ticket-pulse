/**
 * Teams assistant cards and model defaults (plans/TEAMS_BOT_COMMANDS_PLAN.md):
 * the answer card is built from rows, shows 8 and "and N more" with the page
 * link, carries the feedback buttons; the unsure card carries the text; the
 * teams_assistant operation defaults to Haiku 5.5 with GPT-6 Luna behind it.
 */
import { assistantCard, assistantUnsureCard, assistantHelpCard, ASSISTANT_ROWS_SHOWN } from '../src/services/teamsCards.js';
import { getDefaultProviderSetting, AI_OPERATIONS, supportsOperation } from '../src/utils/aiProviders.js';

describe('assistantCard', () => {
  const rows = Array.from({ length: 11 }, (_, i) => ({ id: `ticket:${i}`, title: `Ticket ${i} [with] *marks*`, line: `TP-${1000 + i} · High`, right: 'Tue 20 Oct, 9:14 AM', url: `https://tp.example.com/tickets/${i}` }));
  const card = assistantCard({ title: 'Your tickets', lead: 'You have 11 open tickets.', sections: [{ heading: 'Your open tickets · 11', rows, more: 0, moreUrl: 'https://tp.example.com/tickets?view=mine', moreLabel: 'open my tickets' }], links: [{ title: 'Open my tickets', url: 'https://tp.example.com/tickets?view=mine' }], turnId: 42, note: 'Answered without AI just now.' });
  const json = JSON.stringify(card);

  test('shows 8 rows and "and N more" with the page link', () => {
    const section = card.body.find((b) => b.id === 's0');
    expect(section.items.filter((i) => i.type === 'ColumnSet')).toHaveLength(ASSISTANT_ROWS_SHOWN);
    expect(json).toContain('…and 3 more — [open my tickets](https://tp.example.com/tickets?view=mine)');
  });
  test('every row is a deep link; markdown in subjects is escaped', () => {
    expect(card.body.find((b) => b.id === 's0').items[1].selectAction.url).toBe('https://tp.example.com/tickets/0');
    expect(json).toContain('Ticket 0 \\\\[with\\\\] \\\\*marks\\\\*');
  });
  test('feedback buttons and the no-AI note', () => {
    const verbs = card.actions.filter((a) => a.verb === 'assist.feedback').map((a) => a.data);
    expect(verbs).toEqual([{ turnId: 42, value: 'useful' }, { turnId: 42, value: 'not_right' }]);
    expect(json).toContain('Answered without AI just now.');
  });
  test('the unsure card carries the text in both buttons', () => {
    const u = assistantUnsureCard('the quarterly thing');
    expect(u.actions.map((a) => [a.verb, a.data.choice, a.data.q])).toEqual([['assist.route', 'request', 'the quarterly thing'], ['assist.route', 'question', 'the quarterly thing']]);
  });
  test('the help card offers three example questions as buttons', () => {
    const c = assistantHelpCard({ examples: ['a', 'b', 'c', 'd'] });
    expect(c.actions.filter((a) => a.verb === 'assist.ask').map((a) => a.data.q)).toEqual(['a', 'b', 'c']);
  });
});

describe('the teams_assistant operation', () => {
  test('is registered and defaults to Haiku 5.5 with GPT-6 Luna as the fallback', () => {
    expect(AI_OPERATIONS).toContain('teams_assistant');
    expect(getDefaultProviderSetting('teams_assistant')).toMatchObject({ primaryProvider: 'anthropic', primaryModel: 'claude-haiku-5-5', fallbackProvider: 'openai', fallbackModel: 'gpt-6-luna' });
    expect(supportsOperation('claude-haiku-5-5', 'anthropic', 'teams_assistant')).toBe(true);
    expect(supportsOperation('gpt-6-luna', 'openai', 'teams_assistant')).toBe(true);
  });
  test('other operations keep their defaults', () => {
    expect(getDefaultProviderSetting('auto_help')).toMatchObject({ primaryModel: 'claude-sonnet-5-5', fallbackModel: 'gpt-6.1-sol' });
  });
});
