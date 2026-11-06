/**
 * Teams assistant routing (plans/TEAMS_BOT_COMMANDS_PLAN.md, P0): a question
 * to the bot is answered, a request for IT still goes to Autofill, and when it
 * cannot tell, the bot asks. Plus the keyword router the fallback cards use.
 */
import { classifyMessage, keywordIntents, ticketRefsIn, isStartOver } from '../src/services/teamsAssistantRouting.js';
import { isBotCommand } from '../src/services/teamsIntakeService.js';

const route = (text, opts = {}) => classifyMessage(text, { isCommand: isBotCommand, ...opts }).route;

describe('routing: question vs request vs unsure', () => {
  test('the QA\'s own question (39 characters) goes to the assistant, not the help card', () => {
    expect(route('show me all the approvals pending for me')).toBe('assistant');
  });

  test('the longer natural version (over 60 characters) is no longer offered as a ticket', () => {
    const text = 'can you show me every time-off request still waiting for me to approve';
    expect(text.length).toBeGreaterThan(60);
    expect(route(text)).toBe('assistant');
  });

  test.each([
    'what\'s waiting for me',
    'how many tickets do I have open',
    'tickets due this week?',
    'status of TP-10422',
    'is #231164 closed yet',
    'who\'s out today',
    'aprovals pls',
    'any vacay requests i need to sign off',
    'when is my next vacation',
    'how many vacation days do i have left',
    'is there anything on my plate today that I should be looking at before lunch?',
  ])('question: %s', (text) => {
    expect(route(text)).toBe('assistant');
  });

  test.each([
    'my laptop keeps restarting after the update, can someone look',
    'Rita says her Outlook settings reset every morning and she cannot see the shared calendar anymore',
    'New starter Alex Rivera starts Monday and needs a laptop, a monitor and VPN access set up',
  ])('request for IT (60+ characters) still goes to Autofill: %s', (text) => {
    expect(route(text)).toBe('autofill');
  });

  test('a long text that reads both ways asks first', () => {
    expect(route('can you check why the printer on the third floor is not working for me?')).toBe('unsure');
  });

  test('60+ characters that read as neither ask first', () => {
    expect(route('the quarterly thing from last week with the vendor and the spreadsheet')).toBe('unsure');
  });

  test('short text is the assistant (it can still offer a ticket)', () => {
    expect(route('printer is broken')).toBe('assistant');
    expect(route('hmm ok')).toBe('assistant');
  });

  test('pictures, a long paste or three lines are Autofill as before', () => {
    expect(route('see this', { hasPictures: true })).toBe('autofill');
    expect(route('x'.repeat(300))).toBe('autofill');
    expect(route('one\ntwo\nthree')).toBe('autofill');
  });

  test('bot commands stay commands', () => {
    expect(route('my tickets')).toBe('command');
    expect(route('settings')).toBe('command');
    expect(route('help')).toBe('command');
    expect(route('hi')).toBe('command');
    expect(route('my tickets', { hasPictures: true })).toBe('command');
    expect(route('')).toBe('command');
  });
});

describe('keyword router (the fallback cards)', () => {
  const tools = (text) => keywordIntents(text).map((i) => `${i.tool}${i.input.side ? `:${i.input.side}` : ''}${i.input.filter ? `:${i.input.filter}` : ''}${i.input.scope ? `:${i.input.scope}` : ''}${i.input.date ? `:${i.input.date}` : ''}${i.input.ref ? `:${i.input.ref}` : ''}`);

  test.each([
    ['show me all the approvals pending for me', ['my_pending_approvals:to_decide', 'time_away_waiting_for_me']],
    ['show me all the availability requests waiting for me', ['time_away_waiting_for_me']],
    ['any vacation requests i need to approve', ['time_away_waiting_for_me']],
    ['approvals I asked for that are still open', ['my_pending_approvals:i_asked']],
    ['status of TP-10422', ['ticket_status:TP-10422']],
    ['where is 246762 at', ['ticket_status:246762']],
    ['is #231164 closed yet', ['ticket_status:#231164']],
    ['who\'s out today', ['who_is_away:today']],
    ['is anyone off tomorrow', ['who_is_away:tomorrow']],
    ['who is off tomorrow', ['who_is_away:tomorrow']],
    ['my overdue stuff', ['my_tickets:overdue']],
    ['what is due today', ['my_tickets:due_today']],
    ['tickets due this week?', ['my_tickets:due_this_week']],
    ['my tickets please', ['my_tickets:open']],
    ['how many vacation days do i have left', ['my_time_away:this_year']],
    ['when is my next vacation', ['my_time_away:upcoming']],
    ['what can you do', []],
  ])('%s', (text, expected) => {
    expect(tools(text)).toEqual(expected);
  });

  test('ticket references: TP-, #, a bare number of 4+ digits', () => {
    expect(ticketRefsIn('tp 10422?')).toEqual(['TP-10422']);
    expect(ticketRefsIn('TP-1 and #231164')).toEqual(['TP-1', '#231164']);
    expect(ticketRefsIn('where is 246762 at')).toEqual(['246762']);
    expect(ticketRefsIn('at 123 main')).toEqual([]);
  });

  test('"start over" clears the memory', () => {
    expect(isStartOver('start over')).toBe(true);
    expect(isStartOver('Never mind.')).toBe(true);
    expect(isStartOver('start over with my tickets')).toBe(false);
  });
});
