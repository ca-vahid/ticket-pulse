/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import DOMPurify from 'dompurify';
import { ThemeProvider, useTheme } from '../../contexts/ThemeContext';
import {
  AgentFirstName, ExternalChip, FeaturedFieldChip, MirrorChip, OriginChip, PersonAvatar, PriorityDot, QueueStatePill, SafeHtml, SlaChip, SlaTargetChip, StatusPill, formatDay, formatDayTime, initials, isNonAuthorialColor, parseColor, slaTargetState, timeAgo, timeAgoShort,
} from './ticketUi';

afterEach(cleanup);

describe('ticketUi helpers', () => {
  test('timeAgo formats recent and old values', () => {
    expect(timeAgo(new Date(Date.now() - 10 * 1000))).toBe('just now');
    expect(timeAgo(new Date(Date.now() - 5 * 60 * 1000))).toBe('5m ago');
    expect(timeAgo(new Date(Date.now() - 3 * 3600 * 1000))).toBe('3h ago');
    expect(timeAgo(null)).toBe('—');
  });

  test('timeAgoShort keeps counting past 7 days instead of returning a date (QA 08-24 #2)', () => {
    const ago = (ms) => new Date(Date.now() - ms);
    const DAY = 24 * 3600 * 1000;
    // Shares timeAgo's sub-week ladder…
    expect(timeAgoShort(ago(10 * 1000))).toBe('just now');
    expect(timeAgoShort(ago(5 * 60 * 1000))).toBe('5m ago');
    expect(timeAgoShort(ago(3 * 3600 * 1000))).toBe('3h ago');
    expect(timeAgoShort(ago(6 * DAY))).toBe('6d ago');
    // …and at the 7-day boundary timeAgo becomes a DATE while timeAgoShort stays relative.
    expect(timeAgo(ago(7 * DAY))).not.toMatch(/ago$/);
    expect(timeAgoShort(ago(7 * DAY))).toBe('1w ago');
    expect(timeAgoShort(ago(8 * DAY))).toBe('1w ago');
    expect(timeAgoShort(ago(13 * DAY))).toBe('1w ago');
    expect(timeAgoShort(ago(14 * DAY))).toBe('2w ago');
    expect(timeAgoShort(ago(29 * DAY))).toBe('4w ago');
    expect(timeAgoShort(ago(30 * DAY))).toBe('1mo ago');
    expect(timeAgoShort(ago(150 * DAY))).toBe('5mo ago');
    expect(timeAgoShort(ago(364 * DAY))).toBe('12mo ago');
    expect(timeAgoShort(ago(365 * DAY))).toBe('1y ago');
    expect(timeAgoShort(ago(2 * 365 * DAY + DAY))).toBe('2y ago');
    expect(timeAgoShort(null)).toBe('—');
    expect(timeAgoShort('not a date')).toBe('—');
  });

  test('formatDayTime/formatDay spell out the year only when the date is off-year (QA 08-04 #17a)', () => {
    // Midday mid-month so no timezone can nudge the date across a year edge.
    const thisYear = new Date();
    thisYear.setMonth(6, 15);
    thisYear.setHours(12, 0, 0, 0);
    const lastYear = new Date(thisYear);
    lastYear.setFullYear(thisYear.getFullYear() - 1);

    expect(formatDayTime(thisYear)).not.toContain(String(thisYear.getFullYear()));
    expect(formatDayTime(lastYear)).toContain(String(lastYear.getFullYear()));
    expect(formatDay(thisYear)).not.toContain(String(thisYear.getFullYear()));
    expect(formatDay(lastYear)).toContain(String(lastYear.getFullYear()));
    expect(formatDayTime(null)).toBe('—');
    expect(formatDay('not-a-date')).toBe('—');
  });

  test('initials collapses names', () => {
    expect(initials('Rita Requester')).toBe('RR');
    expect(initials('Cher')).toBe('C');
    expect(initials('')).toBe('?');
  });

  test('slaTargetState covers the SLA badge state machine', () => {
    const target = new Date('2026-07-28T13:00:00Z');
    const before = new Date('2026-07-28T09:00:00Z');
    const after = new Date('2026-07-29T13:00:00Z');
    // Met at/before target → met (green), never live.
    expect(slaTargetState({ target, metAt: before, isTerminal: true }).state).toBe('met');
    expect(slaTargetState({ target, metAt: target, isTerminal: false }).state).toBe('met');
    // Met after target → late (amber, historical), even while the ticket is open.
    expect(slaTargetState({ target, metAt: after, isTerminal: false }).state).toBe('late');
    expect(slaTargetState({ target, metAt: after, isTerminal: true }).state).toBe('late');
    // Terminal ticket, fulfillment time unknown → unknown (quiet), NEVER overdue.
    expect(slaTargetState({ target, metAt: null, isTerminal: true }).state).toBe('unknown');
    // Open ticket, not yet fulfilled → live (countdown/overdue chip applies).
    expect(slaTargetState({ target, metAt: null, isTerminal: false }).state).toBe('live');
    // No/invalid target → no row state at all.
    expect(slaTargetState({ target: null })).toBeNull();
    expect(slaTargetState({ target: 'not-a-date' })).toBeNull();
  });
});

describe('ticketUi components', () => {
  test('StatusPill renders known and unknown statuses', () => {
    render(<StatusPill status="Open" />);
    expect(screen.getByText('Open')).toBeInTheDocument();
    render(<StatusPill status="Weird" />);
    expect(screen.getByText('Weird')).toBeInTheDocument();
  });

  test('PriorityDot exposes an accessible priority label', () => {
    render(<PriorityDot priority={4} />);
    expect(screen.getByText('Urgent priority')).toBeInTheDocument();
  });

  test('PriorityDot withLabel shows the word; the title can be overridden for the read-only FS note (Phase QX)', () => {
    const { container } = render(<PriorityDot priority={3} withLabel title="Priority: High — synced from FreshService, read-only here" />);
    expect(screen.getByText('High')).toBeInTheDocument();
    expect(container.firstChild).toHaveAttribute('title', 'Priority: High — synced from FreshService, read-only here');
  });

  // Queue State column (Mega 08-30 Phase QX): labelled pill per server state,
  // StatusPill geometry, tones in the StateChip family, "—" for null with the
  // incomplete-history caveat in the tooltip.
  test.each([
    ['new', 'New', 'bg-blue-50', 'text-blue-700'],
    ['response_due', 'Response due', 'bg-amber-50', 'text-amber-700'],
    ['requester_responded', 'Requester replied', 'bg-sky-50', 'text-sky-700'],
  ])('QueueStatePill %s renders a labelled pill', (state, label, bg, fg) => {
    render(<QueueStatePill state={state} />);
    const pill = screen.getByText(label).closest('span[title]');
    expect(pill).toHaveClass('rounded-full', 'text-[11px]', 'font-semibold', bg, fg);
    expect(pill.title).toContain(label);
    expect(pill.title).toMatch(/First-response history is incomplete/);
  });

  test('QueueStatePill null/unknown → quiet "—" carrying the caveat, never a guessed state', () => {
    render(<QueueStatePill state={null} />);
    const dash = screen.getByLabelText('No state');
    expect(dash).toHaveTextContent('—');
    // Dark mode (DM-B): the quiet dash rides the muted token at half strength.
    expect(dash).toHaveClass('text-muted-foreground/50');
    expect(dash.title).toMatch(/unknown/);
    expect(dash.title).toMatch(/First-response history is incomplete/);
    cleanup();
    render(<QueueStatePill state="overdue" />); // not a queue state — the SLA chip owns it
    expect(screen.getByLabelText('No state')).toBeInTheDocument();
  });

  test('OriginChip distinguishes TP-born from FS-born', () => {
    render(<OriginChip origin="ticketpulse" />);
    expect(screen.getByText('Ticket Pulse')).toBeInTheDocument();
    render(<OriginChip origin="freshservice" />);
    expect(screen.getByText('FreshService')).toBeInTheDocument();
  });

  test('MirrorChip only renders for TP-born tickets and reflects state', () => {
    const { container } = render(<MirrorChip ticket={{ origin: 'freshservice' }} />);
    expect(container).toBeEmptyDOMElement();

    render(<MirrorChip ticket={{ origin: 'ticketpulse', mirrorState: 'pending' }} />);
    expect(screen.getByText('Mirror pending')).toBeInTheDocument();

    render(<MirrorChip ticket={{ origin: 'ticketpulse', mirrorState: 'mirrored' }} />);
    expect(screen.getByText('Mirrored')).toBeInTheDocument();

    render(<MirrorChip ticket={{ origin: 'ticketpulse', mirrorState: 'error', mirrorError: 'boom' }} />);
    expect(screen.getByText('Mirror error')).toBeInTheDocument();
  });

  test('AgentFirstName is display-only: first name below xl, full name at xl+ and in the tooltip (QA 08-04 iPad)', () => {
    const { container } = render(<AgentFirstName name="Mehdi Rahimi" className="text-xs" />);
    const wrapper = container.firstChild;
    // Full name always survives in the tooltip — no data is lost on tablets.
    expect(wrapper).toHaveAttribute('title', 'Mehdi Rahimi');
    // Two CSS-swapped spans: tablet band shows the first name only, xl+ the full name.
    expect(screen.getByText('Mehdi')).toHaveClass('xl:hidden');
    expect(screen.getByText('Mehdi Rahimi')).toHaveClass('hidden', 'xl:inline');
    // Empty names render nothing rather than an empty chip.
    const empty = render(<AgentFirstName name="  " />);
    expect(empty.container).toBeEmptyDOMElement();
  });

  test('ExternalChip wraps as a unit instead of compressing into neighbours (QA 08-04 #5)', () => {
    render(<ExternalChip />);
    const chip = screen.getByText('External');
    expect(chip).toHaveClass('shrink-0', 'whitespace-nowrap');
  });

  test('PersonAvatar falls back to initials, then to a generic glyph', () => {
    render(<PersonAvatar name="Terry Tech" />);
    expect(screen.getByText('TT')).toBeInTheDocument();
    const { container } = render(<PersonAvatar name={null} />);
    expect(container.querySelector('svg')).toBeTruthy();
  });

  test('SlaTargetChip never shows a live Overdue badge on a closed ticket (bug: FS #234903)', () => {
    // Closed ticket, first-response target a week in the past, reply time
    // unknown (sparse FS data) → quiet "—" chip with an explanatory tooltip.
    const pastTarget = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    render(<SlaTargetChip target={pastTarget} metAt={null} status="Closed" kind="response" />);
    const quiet = screen.getByText('—');
    expect(quiet).toBeInTheDocument();
    expect(quiet).toHaveAttribute('title', expect.stringContaining('First response target was'));
    expect(screen.queryByText(/Overdue/)).not.toBeInTheDocument();
  });

  test('SlaTargetChip freezes outcomes: Met, Met late, Done, Resolved late', () => {
    const target = '2026-07-28T13:00:00Z';
    render(<SlaTargetChip target={target} metAt="2026-07-28T09:00:00Z" status="Open" kind="response" />);
    expect(screen.getByText('Met')).toBeInTheDocument();
    render(<SlaTargetChip target={target} metAt="2026-07-30T09:00:00Z" status="Closed" kind="response" />);
    expect(screen.getByText('Met late')).toBeInTheDocument();
    render(<SlaTargetChip target={target} metAt="2026-07-27T09:00:00Z" status="Resolved" kind="resolution" />);
    expect(screen.getByText('Done')).toBeInTheDocument();
    render(<SlaTargetChip target={target} metAt="2026-07-29T21:00:00Z" status="Closed" kind="resolution" />);
    expect(screen.getByText('Resolved late')).toBeInTheDocument();
    expect(screen.queryByText(/Overdue/)).not.toBeInTheDocument();
  });

  // Phase SLA (QA 08-17 #9) — calendar-aware workspaces explain the clock.
  test('SlaChip live countdown carries the business-hours tooltip only when calendarAware', () => {
    const futureTarget = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
    render(<SlaChip value={futureTarget} calendarAware />);
    expect(screen.getByText(/left/)).toHaveAttribute('title', expect.stringContaining('Business-hours clock'));
    cleanup();
    render(<SlaChip value={futureTarget} />);
    expect(screen.getByText(/left/)).not.toHaveAttribute('title');
    cleanup();
    // Paused keeps its own explanation regardless of the calendar flag.
    render(<SlaChip value={futureTarget} paused calendarAware />);
    expect(screen.getByText('Paused')).toHaveAttribute('title', expect.stringContaining('paused while the ticket is pending'));
  });

  test('SlaTargetChip threads calendarAware to the live chip but not to frozen outcomes', () => {
    const futureTarget = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
    render(<SlaTargetChip target={futureTarget} metAt={null} status="Open" kind="resolution" calendarAware />);
    expect(screen.getByText(/left/)).toHaveAttribute('title', expect.stringContaining('Business-hours clock'));
    cleanup();
    render(<SlaTargetChip target="2026-07-28T13:00:00Z" metAt="2026-07-28T09:00:00Z" status="Open" kind="response" calendarAware />);
    // Frozen outcome keeps its met/late tooltip — no clock-mode noise.
    expect(screen.getByText('Met')).toHaveAttribute('title', expect.stringContaining('before the'));
  });

  test('SlaTargetChip keeps the live countdown for open tickets past due', () => {
    const pastTarget = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
    render(<SlaTargetChip target={pastTarget} metAt={null} status="Open" kind="response" />);
    expect(screen.getByText(/Overdue/)).toBeInTheDocument();
    // Pending pauses the clock instead of nagging.
    cleanup();
    render(<SlaTargetChip target={pastTarget} metAt={null} status="Pending" kind="response" />);
    expect(screen.getByText('Paused')).toBeInTheDocument();
  });

  // Phase 2 — the featured custom-field chip on queue rows / peek.
  test('FeaturedFieldChip renders "Label: value", truncated ~24ch with full text in the tooltip', () => {
    const def = { key: 'client_name', label: 'Client Name' };
    render(<FeaturedFieldChip def={def} value="ACME" />);
    expect(screen.getByText('Client Name: ACME')).toBeInTheDocument();

    cleanup();
    render(<FeaturedFieldChip def={def} value="Coyote Landslide Geotechnical" />);
    const chip = screen.getByTestId('featured-field-chip');
    expect(chip).toHaveAttribute('title', 'Client Name: Coyote Landslide Geotechnical');
    expect(chip.textContent.length).toBeLessThanOrEqual(24);
    expect(chip.textContent.endsWith('…')).toBe(true);
  });

  // Phase DW (QA 08-31 #5): dark-mode conditional email rendering.
  describe('SafeHtml', () => {
    const bodyOf = (html) => render(<SafeHtml html={html} />).container.firstChild;

    test('neutralizes near-black inline colors (Outlook quote headers) but keeps siblings and real colors', () => {
      const body = bodyOf(
        '<p style="color:#000">a</p>' +
        '<p style="color: black; font-weight: bold">b</p>' +
        '<p style="color:windowtext">c</p>' +
        '<p style="color:rgb(0,0,0)">d</p>' +
        '<p style="color: rgb(20, 20, 20)">e</p>' +
        '<font color="black">f</font>',
      );
      // No `color:` declaration survives anywhere…
      expect(body.innerHTML).not.toMatch(/(?:^|[;"\s])color\s*:/i);
      // …but sibling declarations on the same style attr do.
      expect(body.innerHTML).toContain('font-weight');
      expect(body.querySelector('font').hasAttribute('color')).toBe(false);
      // With every color neutralized, the body renders fully themed.
      expect(body).toHaveClass('tp-rich-body', 'tp-rich-body--themed');
      expect(body).not.toHaveClass('tp-rich-body--paper');
    });

    test('keeps genuine author colors (#c00, rgb above the ≤29 threshold) and stamps --paper', () => {
      const red = bodyOf('<p style="color:#c00">warn</p>');
      expect(red.innerHTML).toContain('color:#c00');
      expect(red).toHaveClass('tp-rich-body--paper');
      cleanup();
      // rgb(72,72,72) must NOT be misread channel-by-digit as near-black.
      const gray = bodyOf('<span style="color: rgb(72, 72, 72)">gray</span>');
      expect(gray.innerHTML).toContain('rgb(72, 72, 72)');
      expect(gray).toHaveClass('tp-rich-body--paper');
    });

    test('plain / lightly-formatted HTML stamps --themed', () => {
      const body = bodyOf('<p>hello <a href="https://x.test">link</a></p><ul><li>item</li></ul>');
      expect(body).toHaveClass('tp-rich-body', 'tp-rich-body--themed');
      expect(body).not.toHaveClass('tp-rich-body--paper');
    });

    test('bgcolor= and <font color> force --paper', () => {
      const table = bodyOf('<table><tbody><tr><td bgcolor="#ffff00">x</td></tr></tbody></table>');
      expect(table).toHaveClass('tp-rich-body--paper');
      cleanup();
      const font = bodyOf('<font color="#c00">branded</font>');
      expect(font).toHaveClass('tp-rich-body--paper');
    });

    test('background-color is left alone by the neutralizer (and forces --paper)', () => {
      const body = bodyOf('<p style="background-color:#000">inverse chip</p>');
      expect(body.innerHTML).toContain('background-color:#000');
      expect(body).toHaveClass('tp-rich-body--paper');
    });

    test('border-color / outline-color alone do NOT force --paper', () => {
      const body = bodyOf('<p style="border-color:#c00;border-style:solid;outline-color:#0f0">boxed</p>');
      expect(body).toHaveClass('tp-rich-body--themed');
      expect(body).not.toHaveClass('tp-rich-body--paper');
    });

    test('sanitize is memoized on html (no re-sanitize on unrelated parent re-renders)', () => {
      const spy = vi.spyOn(DOMPurify, 'sanitize');
      const { rerender } = render(<SafeHtml html="<p>hi</p>" />);
      const initialCalls = spy.mock.calls.length;
      expect(initialCalls).toBeGreaterThan(0);
      rerender(<SafeHtml html="<p>hi</p>" />);
      expect(spy.mock.calls.length).toBe(initialCalls);
      rerender(<SafeHtml html="<p>bye</p>" />);
      expect(spy.mock.calls.length).toBe(initialCalls + 1);
      spy.mockRestore();
    });

    // Neutraliser v2 (QA 09-01 #6): theme-gated. Everything above ran without
    // a ThemeProvider (= light fallback) and pins the v3.8.11 behaviour; the
    // dark branch below maps/drops non-authorial colours.
    describe('neutraliser v2 (dark mode)', () => {
      const themed = (html, theme = 'dark') => {
        localStorage.setItem('tp_theme', theme);
        return render(<ThemeProvider><SafeHtml html={html} /></ThemeProvider>).container.firstChild;
      };
      // Mid-grey de-emphasis maps to the muted token (not a leftover author colour).
      const MUTED = /color:\s*hsl\(var\(--muted-foreground\)\)/gi;
      const noColorDecl = (el) => expect(el.innerHTML.replace(MUTED, '')).not.toMatch(/(?:^|[;"\s])color\s*:/i);

      test('mid-grey text keeps its de-emphasis via the muted token; near-black and near-white greys drop', () => {
        const el = themed('<p>Body <span style="color:#A6A6A6">Privacy footer</span> <span style="color:#111111">dark</span> <span style="color:#F5F5F5">light</span> <a href="https://x.test" style="color:#808080">link</a></p>');
        expect(el.className).toMatch(/tp-rich-body--themed/);
        const spans = el.querySelectorAll('span');
        expect(spans[0].getAttribute('style')).toMatch(/hsl\(var\(--muted-foreground\)\)/);
        expect(spans[1].getAttribute('style') || '').not.toMatch(/color/);
        expect(spans[2].getAttribute('style') || '').not.toMatch(/color/);
        expect(el.querySelector('a').getAttribute('style') || '').not.toMatch(/color/);
      });

      beforeEach(() => {
        localStorage.clear();
        document.documentElement.classList.remove('dark');
      });
      afterEach(() => {
        localStorage.clear();
        document.documentElement.classList.remove('dark');
      });

      // Redacted FS #240242: Outlook quote header, Office-default link,
      // white table cells, cid background, and the ONE colour that survived
      // v3.8.11 — the grey disclaimer footer.
      const FS_240242 = (
        '<div style="color:black;font-family:Calibri">Hi team,</div>' +
        '<p style="color:windowtext">Please see <a href="https://x.test" style="color:#0563C1;text-decoration:underline">the portal</a>.</p>' +
        '<table bgcolor="#FFFFFF" background="cid:image001.png@01DC"><tbody><tr>' +
        '<td style="background:white;padding:2px"><span style="color:rgb(0,0,0)">Item</span></td></tr></tbody></table>' +
        '<p style="color:inherit;background:transparent">Regards</p>' +
        '<span style="color:#A6A6A6;font-size:9pt">Privacy Policy: This message is confidential…</span>'
      );

      test('greys at any lightness, white, keywords → dropped, body --themed', () => {
        const body = themed(
          '<p style="color:#A6A6A6">footer</p>' +
          '<span style="color: rgb(72, 72, 72)">mid</span>' +
          '<span style="color:#f5f5f5">light</span>' +
          '<span style="color:silver">named</span>' +
          '<span style="color:inherit">kw1</span>' +
          '<span style="color:transparent">kw2</span>' +
          '<span style="color:rgba(0,0,0,0)">alpha0</span>' +
          '<font color="gray">f</font>',
        );
        noColorDecl(body);
        expect(body.querySelector('font').hasAttribute('color')).toBe(false);
        expect(body).toHaveClass('tp-rich-body--themed');
        expect(body).not.toHaveClass('tp-rich-body--paper');
      });

      test('white cell backgrounds, background:white and the legacy background= image → --themed, attrs removed', () => {
        const body = themed(
          '<table><tbody><tr><td bgcolor="#ffffff" background="x.png" style="background:white;padding:1px">x</td></tr></tbody></table>',
        );
        const td = body.querySelector('td');
        expect(td.hasAttribute('bgcolor')).toBe(false);
        expect(td.hasAttribute('background')).toBe(false);
        expect(td.getAttribute('style')).toBe('padding:1px');
        expect(body).toHaveClass('tp-rich-body--themed');
      });

      test('background shorthand with a data: URI is dropped whole (paren-aware split keeps siblings)', () => {
        const body = themed('<div style="font-weight:bold;background:url(data:image/png;base64,AAA;BBB) no-repeat #fff;margin:0">x</div>');
        expect(body.querySelector('div').getAttribute('style')).toBe('font-weight:bold;margin:0');
        expect(body).toHaveClass('tp-rich-body--themed');
      });

      test('Office link defaults and any colour inside a link → dropped', () => {
        const body = themed(
          '<a href="https://x.test" style="color:#0563C1">link</a>' +
          '<a href="https://x.test"><span style="color:#EE0000">inside</span></a>' +
          '<span style="color:blue">legacy blue</span>' +
          '<span style="color:#954F72">followed</span>',
        );
        noColorDecl(body);
        expect(body).toHaveClass('tp-rich-body--themed');
      });

      test('dark saturated text is LIFTED to the same hue at 70% lightness and does not count', () => {
        const body = themed('<p><span style="color:#0C1975;font-weight:bold">BGC Engineering</span></p>');
        expect(body.querySelector('span').getAttribute('style')).toBe('color:hsl(233 81% 70%);font-weight:bold');
        expect(body).toHaveClass('tp-rich-body--themed');
        cleanup();
        // <font color> can't carry hsl() (legacy colour parser) — the lift moves to style.
        const font = themed('<font color="#1F497D" face="Calibri">navy</font>');
        const fontEl = font.querySelector('font');
        expect(fontEl.hasAttribute('color')).toBe(false);
        expect(fontEl.getAttribute('style')).toMatch(/^color:hsl\(\d+ \d+% 70%\)$/);
        expect(fontEl.getAttribute('face')).toBe('Calibri');
        expect(font).toHaveClass('tp-rich-body--themed');
      });

      test('light saturated text (#EE0000, #5B9BD5) is kept verbatim and does not count', () => {
        const body = themed('<span style="color:#EE0000">-12.5%</span><span style="color:#5B9BD5">sky</span>');
        expect(body.innerHTML).toContain('color:#EE0000');
        expect(body.innerHTML).toContain('color:#5B9BD5');
        expect(body).toHaveClass('tp-rich-body--themed');
      });

      test('ONLY saturated backgrounds trigger --paper (bgcolor, background, background-color)', () => {
        const yellow = themed('<table><tbody><tr><td bgcolor="#ffff00">x</td></tr></tbody></table>');
        expect(yellow.querySelector('td').getAttribute('bgcolor')).toBe('#ffff00');
        expect(yellow).toHaveClass('tp-rich-body--paper');
        cleanup();
        const teal = themed('<table><tbody><tr><th style="background:#156082;color:white">Aging</th><td style="color:#EE0000">-3</td></tr></tbody></table>');
        expect(teal.innerHTML).toContain('background:#156082');
        expect(teal.innerHTML).toContain('color:#EE0000');
        expect(teal).toHaveClass('tp-rich-body--paper');
        cleanup();
        const banner = themed('<table style="background-color:#1B348E"><tbody><tr><td>banner</td></tr></tbody></table>');
        expect(banner.innerHTML).toContain('background-color:#1B348E');
        expect(banner).toHaveClass('tp-rich-body--paper');
      });

      test('the redacted FS #240242 body renders --themed with the grey footer neutralised', () => {
        const body = themed(FS_240242);
        noColorDecl(body);
        expect(body.innerHTML).not.toMatch(/bgcolor|background/i);
        expect(body.innerHTML).toContain('Privacy Policy');
        expect(body).toHaveClass('tp-rich-body--themed');
      });

      test('near-black and border-color rules still hold in dark', () => {
        const body = themed('<p style="color:#000">a</p><p style="border-color:#c00;border-style:solid;outline-color:#0f0">b</p>');
        noColorDecl(body);
        expect(body.innerHTML).toContain('border-color:#c00');
        expect(body).toHaveClass('tp-rich-body--themed');
      });

      test('LIGHT mode keeps v3.8.11 exactly: #A6A6A6 and #0C1975 stay intact (and count)', () => {
        const body = themed('<span style="color:#A6A6A6">footer</span><span style="color:#0C1975">navy</span><a style="color:#0563C1">l</a>', 'light');
        expect(body.innerHTML).toContain('color:#A6A6A6');
        expect(body.innerHTML).toContain('color:#0C1975');
        expect(body.innerHTML).toContain('color:#0563C1');
        expect(body).toHaveClass('tp-rich-body--paper');
      });

      test('a theme flip re-sanitises exactly once (memo on [html, isDark])', () => {
        localStorage.setItem('tp_theme', 'light');
        const html = '<span style="color:#A6A6A6">footer</span>';
        function Flip() {
          const { setTheme } = useTheme();
          return <button type="button" onClick={() => setTheme('dark')}>dark</button>;
        }
        const spy = vi.spyOn(DOMPurify, 'sanitize');
        const { container, rerender } = render(<ThemeProvider><Flip /><SafeHtml html={html} /></ThemeProvider>);
        const calls = spy.mock.calls.length;
        expect(container.querySelector('.tp-rich-body')).toHaveClass('tp-rich-body--paper');
        fireEvent.click(screen.getByText('dark'));
        expect(spy.mock.calls.length).toBe(calls + 1);
        expect(container.querySelector('.tp-rich-body')).toHaveClass('tp-rich-body--themed');
        expect(container.querySelector('.tp-rich-body').innerHTML).not.toContain('#A6A6A6');
        rerender(<ThemeProvider><Flip /><SafeHtml html={html} /></ThemeProvider>);
        expect(spy.mock.calls.length).toBe(calls + 1);
        spy.mockRestore();
      });
    });

    describe('parseColor / isNonAuthorialColor', () => {
      test('parses hex 3/4/6/8, rgb/rgba (alpha 0 → transparent), named greys', () => {
        expect(parseColor('#abc').rgb).toEqual([170, 187, 204]);
        expect(parseColor('#abcd').a).toBeCloseTo(0.867, 2);
        expect(parseColor('#0C1975').rgb).toEqual([12, 25, 117]);
        expect(parseColor('#00000000')).toEqual({ keyword: 'transparent' });
        expect(parseColor('rgb(72, 72, 72)').rgb).toEqual([72, 72, 72]);
        expect(parseColor('rgba(255,0,0,0)')).toEqual({ keyword: 'transparent' });
        expect(parseColor('rgb(10 20 30 / 0.5)').a).toBe(0.5);
        expect(parseColor('Silver').rgb).toEqual([192, 192, 192]);
        expect(parseColor('WindowText')).toEqual({ keyword: 'windowtext' });
        expect(parseColor('var(--x)')).toBeNull();
      });
      test('classifies keywords, links, Office defaults and grayscale as non-authorial', () => {
        expect(isNonAuthorialColor('inherit')).toBe(true);
        expect(isNonAuthorialColor('#EE0000', { inLink: true })).toBe(true);
        expect(isNonAuthorialColor('#EE0000', { tag: 'A' })).toBe(true);
        expect(isNonAuthorialColor('#0563c1')).toBe(true);
        expect(isNonAuthorialColor('blue')).toBe(true);
        expect(isNonAuthorialColor('#A6A6A6')).toBe(true);
        expect(isNonAuthorialColor('#f8f8f0')).toBe(true); // spread 8
        expect(isNonAuthorialColor('#EE0000')).toBe(false);
        expect(isNonAuthorialColor('#0C1975')).toBe(false);
        expect(isNonAuthorialColor('hsl(1 2% 3%)')).toBe(false); // unknown → authorial
      });
    });
  });

  test('FeaturedFieldChip: booleans render Yes/No; empty values render nothing', () => {
    const def = { key: 'expedite', label: 'Expedite' };
    render(<FeaturedFieldChip def={def} value={true} />);
    expect(screen.getByText('Expedite: Yes')).toBeInTheDocument();
    cleanup();
    const { container } = render(<FeaturedFieldChip def={def} value="" />);
    expect(container).toBeEmptyDOMElement();
    cleanup();
    const none = render(<FeaturedFieldChip def={null} value="x" />);
    expect(none.container).toBeEmptyDOMElement();
  });
});
