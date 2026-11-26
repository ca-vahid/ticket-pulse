import { describe, expect, test } from 'vitest';
import { swapFsTicketId, usesFsTicketId } from './fsTicketIdLint';

describe('the FreshService id in workflow e-mails (26 Nov 2026)', () => {
  test('spots the variable in any of the fields', () => {
    expect(usesFsTicketId('Ticket received: #{{ ticket.freshserviceTicketId }}')).toBe(true);
    expect(usesFsTicketId(null, '<p>Ref {{ticket.freshserviceTicketId}}</p>')).toBe(true);
    expect(usesFsTicketId('Ticket received: {{ ticket.displayRef }}', '', undefined)).toBe(false);
  });

  test('swaps it for the ticket number and drops the "#" in front', () => {
    expect(swapFsTicketId('Ticket received: #{{ ticket.freshserviceTicketId }}')).toBe('Ticket received: {{ ticket.displayRef }}');
    expect(swapFsTicketId('Ref # {{ticket.freshserviceTicketId}}.')).toBe('Ref {{ticket.displayRef}}.');
    expect(swapFsTicketId('{{- ticket.freshserviceTicketId | default: "?" }}')).toBe('{{- ticket.displayRef | default: "?" }}');
  });

  test('leaves other text alone, and passes empty values through', () => {
    expect(swapFsTicketId('Invoice #123 for {{ ticket.subject }}')).toBe('Invoice #123 for {{ ticket.subject }}');
    expect(swapFsTicketId(undefined)).toBeUndefined();
    expect(swapFsTicketId(null)).toBeNull();
  });
});
