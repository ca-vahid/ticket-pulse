import { freshserviceTicketNumbers } from '../src/utils/freshserviceRefs.js';

// The shapes seen in the it@ inbox on 12 Oct 2026.
describe('FreshService ticket numbers in mail', () => {
  test.each([
    ['Re: [INC-243414] GIS Pro licence', [243414]],
    ['Re: [#SR-246489] new starter', [246489]],
    ['[INC-246489] *URGENT* new starter', [246489]],
    ['Re: Mailbox permission for someone [#246332]', [246332]],
    ['Ticket #224183 has been updated', [224183]],
    ['Fw: [INC-243414] same as [#SR-246489] and [INC-243414] again', [243414, 246489]],
  ])('%s', (subject, expected) => {
    expect(freshserviceTicketNumbers(subject)).toEqual(expected);
  });

  test('ordinary numbers are not ticket numbers', () => {
    expect(freshserviceTicketNumbers('Invoice 2026-10-0457 for PO 88213, room #12')).toEqual([]);
    expect(freshserviceTicketNumbers('TP-1806 laptop')).toEqual([]);
    expect(freshserviceTicketNumbers(null)).toEqual([]);
  });
});
