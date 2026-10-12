import { fsNoteHeader } from '../src/utils/fsNoteHeader.js';

// 12 Oct 2026: FreshService shows every API note as written by "Ticket Pulse", and our first line
// opened with a bold "[Ticket Pulse mirror]", which read as the author. The person now leads.
describe('the first line of a note written on a FreshService ticket', () => {
  const MARK = '[Ticket Pulse mirror]';

  test('the person is the bold part, and the marker trails the line unchanged', () => {
    const html = fsNoteHeader({ who: 'Marcus Blackstock', email: 'mb@example.com', action: 'note', ref: 'TP-1806', url: 'https://tp.example/tickets/9', marker: MARK });
    expect(html).toContain('<b>Marcus Blackstock</b>');
    expect(html).not.toContain(`<b>${MARK}</b>`);
    expect(html.indexOf('Marcus Blackstock')).toBeLessThan(html.indexOf(MARK));
    expect(html).toContain(MARK);
    expect(html).toContain('internal note');
    expect(html).toContain('<a href="https://tp.example/tickets/9">TP-1806</a>');
    // "Name <email>" stays adjacent in the text: the only machine-readable attribution FreshService gets.
    expect(html.replace(/<[^>]+>/g, '')).toMatch(/^Marcus Blackstock &lt;mb@example\.com&gt; · /);
  });

  test('a reply says the requester already has it, and carries no address or link', () => {
    const html = fsNoteHeader({ who: 'Reza Zaim', action: 'reply', ref: 'TP-1806', marker: MARK });
    expect(html).toContain('already e-mailed to the requester');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('&lt;');
  });

  test('names are escaped and a missing name falls back to Ticket Pulse', () => {
    expect(fsNoteHeader({ who: '<script>x</script>', marker: MARK })).toContain('<b>&lt;script&gt;x&lt;/script&gt;</b>');
    expect(fsNoteHeader({ marker: MARK })).toContain('<b>Ticket Pulse</b>');
  });
});
