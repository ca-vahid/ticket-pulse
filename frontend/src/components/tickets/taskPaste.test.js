import { describe, expect, test } from 'vitest';
import { cleanTaskLine, countNonEmptyLines, MAX_PASTED_TASKS, parsePastedTasks } from './taskPaste';

const NB = String.fromCharCode(160); // non-breaking space, as e-mail pastes carry

// QA 11-18 item 3: paste a list into the Tasks tab, one task per line.
describe('cleanTaskLine', () => {
  test.each([
    ['- Order a dock', 'Order a dock'],
    ['* Order a dock', 'Order a dock'],
    ['• Order a dock', 'Order a dock'],
    ['◦ 11-652 - Keyboard and Mouse', '11-652 - Keyboard and Mouse'],
    ['▪ Monitor arm', 'Monitor arm'],
    ['· Monitor arm', 'Monitor arm'],
    ['•Monitor arm', 'Monitor arm'],
    ['1. Monitor arm', 'Monitor arm'],
    ['12) Monitor arm', 'Monitor arm'],
    ['a) Monitor arm', 'Monitor arm'],
    ['(b) Monitor arm', 'Monitor arm'],
    ['o   Monitor arm', 'Monitor arm'],
    ['  - 1. Monitor arm  ', 'Monitor arm'],
    [[NB, NB, '◦', NB, 'Monitor arm'].join(''), 'Monitor arm'],
  ])('%j → %j', (raw, clean) => {
    expect(cleanTaskLine(raw)).toBe(clean);
  });

  test.each([
    '11-652 - Keyboard and Mouse',
    '2.5 GB of storage',
    '-5 degrees in the server room',
    'A. Smith needs a badge',
    'Order a dock',
  ])('leaves %j alone', (text) => {
    expect(cleanTaskLine(text)).toBe(text);
  });
});

describe('parsePastedTasks', () => {
  test('the QA e-mail: a heading line is put in front of the lines under it', () => {
    const text = [
      '- Floor 6:',
      '    ◦ 11-652 - Keyboard and Mouse',
      '    ◦ 2-636 - Keyboard and Mouse',
      '',
      '- Floor 7:',
      '    ◦ 7-101 - Monitor',
    ].join('\r\n');
    const out = parsePastedTasks(text);
    expect(out.tasks).toEqual([
      'Floor 6 · 11-652 - Keyboard and Mouse',
      'Floor 6 · 2-636 - Keyboard and Mouse',
      'Floor 7 · 7-101 - Monitor',
    ]);
    expect(out.headings).toEqual(['Floor 6', 'Floor 7']);
    expect(out.truncated).toBe(false);
    expect(out.total).toBe(3);
  });

  test('plain lines, empty lines dropped, no headings', () => {
    const out = parsePastedTasks('Order dock\n\n  \nSet up printer\n1. Image laptop\n');
    expect(out.tasks).toEqual(['Order dock', 'Set up printer', 'Image laptop']);
    expect(out.headings).toEqual([]);
  });

  test('lines before the first heading keep no prefix', () => {
    const out = parsePastedTasks('Call the vendor\nFloor 6:\n- Desk phone');
    expect(out.tasks).toEqual(['Call the vendor', 'Floor 6 · Desk phone']);
  });

  test('a heading with nothing under it stays as a task, so nothing is lost', () => {
    const out = parsePastedTasks('Floor 6:\nFloor 7:\n- Desk phone\nLobby:');
    expect(out.tasks).toEqual(['Floor 6', 'Floor 7 · Desk phone', 'Lobby']);
    expect(out.headings).toEqual(['Floor 7']);
  });

  test('a blank line ends a heading group', () => {
    const out = parsePastedTasks('Floor 6:\n- Keyboard\n\nOrder cables');
    expect(out.tasks).toEqual(['Floor 6 · Keyboard', 'Order cables']);
  });

  test('a blank line straight after a heading keeps it for the lines below', () => {
    const out = parsePastedTasks('Floor 6:\n\n- Keyboard\n- Mouse');
    expect(out.tasks).toEqual(['Floor 6 · Keyboard', 'Floor 6 · Mouse']);
  });

  test('a colon inside a line is not a heading', () => {
    expect(parsePastedTasks('Note: bring a cable\nRoom 4').tasks).toEqual(['Note: bring a cable', 'Room 4']);
  });

  test(`caps at ${MAX_PASTED_TASKS} and says it was cut`, () => {
    const text = Array.from({ length: 63 }, (_, i) => `- Item ${i + 1}`).join('\n');
    const out = parsePastedTasks(text);
    expect(out.tasks).toHaveLength(MAX_PASTED_TASKS);
    expect(out.tasks[49]).toBe('Item 50');
    expect(out.total).toBe(63);
    expect(out.truncated).toBe(true);
  });

  test('empty input gives no tasks', () => {
    expect(parsePastedTasks('').tasks).toEqual([]);
    expect(parsePastedTasks(null).tasks).toEqual([]);
    expect(parsePastedTasks('-\n•\n  ').tasks).toEqual([]);
  });
});

describe('countNonEmptyLines', () => {
  test('counts only lines with text', () => {
    expect(countNonEmptyLines('one')).toBe(1);
    expect(countNonEmptyLines('one\n\n')).toBe(1);
    expect(countNonEmptyLines('one\r\ntwo')).toBe(2);
    expect(countNonEmptyLines('')).toBe(0);
  });
});
