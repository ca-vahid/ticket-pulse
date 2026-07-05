/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import {
  MirrorChip, OriginChip, PersonAvatar, PriorityDot, StatusPill, initials, timeAgo,
} from './ticketUi';

afterEach(cleanup);

describe('ticketUi helpers', () => {
  test('timeAgo formats recent and old values', () => {
    expect(timeAgo(new Date(Date.now() - 10 * 1000))).toBe('just now');
    expect(timeAgo(new Date(Date.now() - 5 * 60 * 1000))).toBe('5m ago');
    expect(timeAgo(new Date(Date.now() - 3 * 3600 * 1000))).toBe('3h ago');
    expect(timeAgo(null)).toBe('—');
  });

  test('initials collapses names', () => {
    expect(initials('Rita Requester')).toBe('RR');
    expect(initials('Cher')).toBe('C');
    expect(initials('')).toBe('?');
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

  test('PersonAvatar falls back to initials, then to a generic glyph', () => {
    render(<PersonAvatar name="Terry Tech" />);
    expect(screen.getByText('TT')).toBeInTheDocument();
    const { container } = render(<PersonAvatar name={null} />);
    expect(container.querySelector('svg')).toBeTruthy();
  });
});
