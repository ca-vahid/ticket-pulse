/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { actionWords, levelOptions, progressWords, readinessState } from './answeringFormat';

// Knowledge → Answering: the dial per category (plans/KNOWLEDGE_SIMPLIFY_PLAN.md section 5).
const api = { answering: vi.fn(), updateAnswering: vi.fn(), updateSettings: vi.fn(), listPlaybooks: vi.fn() };
const render = (ui) => rtlRender(<MemoryRouter>{ui}</MemoryRouter>);
vi.mock('../../services/api', () => ({ get knowledgeAPI() { return api; } }));
// The app's select opens a portal; a plain select keeps the test about the panel.
vi.mock('../common/FancySelect', () => ({
  default: ({ value, onChange, options, disabled, 'aria-label': label, 'data-testid': testId }) => (
    <select aria-label={label} data-testid={testId} value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => <option key={o.value} value={o.value} disabled={o.disabled} title={o.hint}>{o.label}</option>)}
    </select>
  ),
}));

const { default: AnsweringPanel } = await import('./AnsweringPanel');

const crit = (reviewed, goodPct = null, sends = 0) => ([
  { key: 'reviewed', value: reviewed, target: 30, n: reviewed, met: reviewed >= 30 },
  { key: 'good', value: goodPct, target: 85, n: reviewed, met: goodPct >= 85 },
  { key: 'no_recent_wrong', value: 0, target: 0, n: reviewed, met: reviewed >= 30 },
  { key: 'approve_sends', value: sends, target: 20, n: sends, met: sends >= 20 },
]);
const resolved = (over = {}) => ({ dayLevel: 'draft', nightLevel: 'draft', bar: 0.85, alwaysChecked: false, notes: [], stayQuietWhen: [], ...over });
const DIAL = {
  knowledgeFirst: true, enabled: true, canManage: true, afterHoursNow: false,
  readinessBar: { minReviewed: 30, minGoodPct: 85 },
  default: { own: null, resolved: resolved() },
  categories: [
    {
      id: 10, name: 'Software & Apps', own: { categoryId: 10, dayLevel: 'suggest', nightLevel: null, bar: null, alwaysChecked: null, notes: 'Never quote prices.', stayQuietWhen: [] },
      resolved: resolved({ dayLevel: 'suggest' }), readiness: { met: true, criteria: crit(41, 90, 22) }, articles: 5, runs30: { total: 120, answered: 31 },
      subcategories: [{ id: 101, name: 'OpenGround', own: null, resolved: resolved({ dayLevel: 'suggest' }) }],
    },
    {
      id: 20, name: 'Procurement & Licensing', own: null, resolved: resolved(), readiness: { met: false, criteria: crit(12, 91.7, 3) }, articles: 2, runs30: { total: 40, answered: 9 }, subcategories: [],
    },
    {
      id: 30, name: 'Account & Access', own: { categoryId: 30, alwaysChecked: true, stayQuietWhen: [] }, resolved: resolved({ alwaysChecked: true }), readiness: { met: false, criteria: crit(0) }, articles: 0, runs30: { total: 0, answered: 0 }, subcategories: [],
    },
  ],
};

beforeEach(() => {
  api.answering.mockResolvedValue({ data: DIAL });
  api.updateAnswering.mockImplementation(async () => ({ data: DIAL }));
  api.updateSettings.mockResolvedValue({ data: { knowledgeFirst: false } });
  api.listPlaybooks.mockResolvedValue({ data: [
    { id: 2, name: 'Phones & mobile', enabled: true, isDefault: false, match: { whenToHelp: 'Roaming and travel data questions.' } },
    { id: 1, name: 'Software, apps & licences', enabled: false, isDefault: false, match: {} },
    { id: 40, name: 'Knowledge answers', enabled: true, isDefault: true, match: {} },
  ] });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('answeringFormat', () => {
  test('a row with a parent can follow it; "Send when sure" is offered but locked with the reason', () => {
    const opts = levelOptions({ inherited: 'suggest', parentName: 'Software & Apps', canSend: false, sendLockedWhy: 'Not earned yet' });
    expect(opts.map((o) => o.label)).toEqual(['Same as Software & Apps', 'Off', 'Draft only', 'Suggest to agent', 'Send when sure']);
    expect(opts[0]).toMatchObject({ value: '', hint: 'Suggest to agent' });
    expect(opts.at(-1)).toMatchObject({ value: 'send', disabled: true, hint: 'Not earned yet' });
    expect(levelOptions({ canSend: true }).at(-1).disabled).toBe(false);
    expect(levelOptions({}).map((o) => o.value)).toEqual(['off', 'draft', 'suggest', 'send']);
  });

  test('where a category stands, in words, always with the count', () => {
    expect(readinessState(DIAL.categories[0])).toEqual({ tone: 'ready', words: 'Earned' });
    expect(readinessState(DIAL.categories[1])).toEqual({ tone: 'progress', words: '12 of 30 reviewed' });
    expect(readinessState(DIAL.categories[2])).toEqual({ tone: 'locked', words: 'Always checked by a person' });
    expect(readinessState({ resolved: resolved(), readiness: { met: false, criteria: crit(0) } })).toEqual({ tone: 'none', words: 'No reviewed answers yet' });
    expect(progressWords(DIAL.categories[1].readiness)).toBe('91.7 % good (needs 85 %) · 3 of 20 sent by agents');
  });

  test('what a run did, and why it was moved down', () => {
    expect(actionWords({ action: { level: 'draft', ceiling: 'suggest', reason: 'one_step_down' } })).toEqual({ level: 'Draft only', ceiling: 'Suggest to agent', why: 'one level down: the answer was not fully sure' });
    expect(actionWords({ action: { level: 'suggest', ceiling: 'send', reason: 'not_earned' } }).why).toContain('has not earned sending');
    expect(actionWords({})).toBeNull();
  });
});

describe('AnsweringPanel', () => {
  test('one row per category with its two levels, evidence and counts; a row left alone shows what it follows', async () => {
    render(<AnsweringPanel canManage />);
    const software = await screen.findByTestId('answering-row-10');
    expect(within(software).getByText('Software & Apps')).toBeInTheDocument();
    expect(within(software).getByText('5 articles · 31 of 120 answered in 30 days')).toBeInTheDocument();
    expect(within(software).getByTestId('answering-day-10')).toHaveValue('suggest');
    expect(within(software).getByTestId('answering-night-10')).toHaveValue('');
    expect(within(software).getByTestId('answering-evidence-10')).toHaveTextContent('Earned');
    const procurement = screen.getByTestId('answering-row-20');
    expect(within(procurement).getByTestId('answering-evidence-20')).toHaveTextContent('12 of 30 reviewed');
    expect(within(procurement).getByText('91.7 % good (needs 85 %) · 3 of 20 sent by agents')).toBeInTheDocument();
    expect(within(screen.getByTestId('answering-row-0')).getByText('Everything else')).toBeInTheDocument();
  });

  test('"Send when sure" is selectable only where it was earned', async () => {
    render(<AnsweringPanel canManage />);
    await screen.findByTestId('answering-row-10');
    const sendOf = (testId) => within(screen.getByTestId(testId)).getByRole('option', { name: 'Send when sure' });
    expect(sendOf('answering-night-10')).not.toBeDisabled();
    expect(sendOf('answering-night-20')).toBeDisabled();
    expect(sendOf('answering-night-20')).toHaveAttribute('title', 'Not earned yet');
    expect(sendOf('answering-night-30')).toHaveAttribute('title', 'Always checked by a person');
    expect(sendOf('answering-night-0')).toBeDisabled();
  });

  test('changing a level saves that one field; choosing "Same as" clears it back to inherit', async () => {
    render(<AnsweringPanel canManage />);
    await screen.findByTestId('answering-row-10');
    fireEvent.change(screen.getByTestId('answering-night-10'), { target: { value: 'send' } });
    await waitFor(() => expect(api.updateAnswering).toHaveBeenCalledWith(10, { nightLevel: 'send' }));
    fireEvent.change(screen.getByTestId('answering-day-10'), { target: { value: '' } });
    await waitFor(() => expect(api.updateAnswering).toHaveBeenCalledWith(10, { dayLevel: null }));
  });

  test('details: always checked, the bar, notes, stay-quiet rules and the subcategories', async () => {
    render(<AnsweringPanel canManage />);
    const software = await screen.findByTestId('answering-row-10');
    fireEvent.click(within(software).getByRole('button', { name: 'Show details for Software & Apps' }));
    const details = screen.getByTestId('answering-details-10');
    expect(within(details).getByLabelText('Notes for answers here')).toHaveValue('Never quote prices.');
    fireEvent.change(within(details).getByLabelText('Notes for answers here'), { target: { value: 'Never quote prices. Keep it short.' } });
    fireEvent.click(within(details).getByRole('button', { name: 'Save notes' }));
    await waitFor(() => expect(api.updateAnswering).toHaveBeenCalledWith(10, { notes: 'Never quote prices. Keep it short.' }));
    fireEvent.change(within(details).getByLabelText('How sure an answer must be'), { target: { value: '90' } });
    fireEvent.click(within(details).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateAnswering).toHaveBeenCalledWith(10, { bar: 0.9 }));
    fireEvent.click(within(details).getByRole('switch', { name: 'Always checked by a person' }));
    await waitFor(() => expect(api.updateAnswering).toHaveBeenCalledWith(10, { alwaysChecked: true }));
    // The subcategory follows its category until set.
    const subs = screen.getByTestId('answering-subs-10');
    expect(within(subs).getByText('OpenGround')).toBeInTheDocument();
    expect(within(subs).getAllByRole('option', { name: 'Same as Software & Apps' })).toHaveLength(2);
  });

  test('special handling: the playbooks that are left, on or off in words, and the rule for everything else', async () => {
    render(<AnsweringPanel canManage />);
    const box = await screen.findByTestId('answering-special');
    await waitFor(() => expect(within(box).getByRole('link', { name: 'Phones & mobile' })).toHaveAttribute('href', '/knowledge/playbooks/2'));
    expect(within(box).getByText('Roaming and travel data questions.')).toBeInTheDocument();
    expect(within(box).getByText('On')).toBeInTheDocument();
    expect(within(box).getByText('Off')).toBeInTheDocument();
    expect(within(box).getByRole('link', { name: 'Everything else' })).toHaveAttribute('href', '/knowledge/playbooks/40');
    expect(within(box).queryByText('Knowledge answers')).not.toBeInTheDocument();
    expect(within(box).getByRole('link', { name: 'Manage' })).toHaveAttribute('href', '/knowledge/playbooks');
  });

  test('the order switch saves the workspace setting and says what each state means', async () => {
    const onSettingsChange = vi.fn();
    render(<AnsweringPanel canManage onSettingsChange={onSettingsChange} />);
    const sw = await screen.findByRole('switch', { name: 'Answer from Knowledge first' });
    expect(sw).toBeChecked();
    expect(screen.getByText(/A playbook is only needed for special handling/)).toBeInTheDocument();
    fireEvent.click(sw);
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ knowledgeFirst: false }));
    await waitFor(() => expect(screen.getByText(/A ticket is only answered when a playbook fits it/)).toBeInTheDocument());
    expect(onSettingsChange).toHaveBeenCalledWith({ knowledgeFirst: false });
  });

  test('someone who cannot manage Knowledge sees the dial read-only; a failed save says so', async () => {
    render(<AnsweringPanel canManage={false} />);
    await screen.findByTestId('answering-row-10');
    expect(screen.getByTestId('answering-day-10')).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Answer from Knowledge first' })).toBeDisabled();
    cleanup();
    api.updateAnswering.mockRejectedValueOnce(new Error('This category has not earned "Send when sure" yet'));
    render(<AnsweringPanel canManage />);
    await screen.findByTestId('answering-row-20');
    fireEvent.change(screen.getByTestId('answering-day-20'), { target: { value: 'suggest' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('has not earned');
  });
});
