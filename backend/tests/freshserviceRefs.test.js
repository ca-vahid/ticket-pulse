import { freshserviceTicketNumbers, parseTicketPrefixes } from '../src/utils/freshserviceRefs.js';

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

// 6 Nov 2026: Accounting's FreshService numbers tickets [CASE-n]. Read only where the
// workspace says so (fs_ticket_prefixes_ws<N>): a vendor's "Case #CASE-249123" sent to IT
// must not thread onto IT ticket 249123 (IT's FreshService ids are in the same range).
describe('workspace ticket prefixes (CASE)', () => {
  test('without the workspace prefix, no CASE form is read (IT: vendor case numbers)', () => {
    expect(freshserviceTicketNumbers('Microsoft Case #CASE-249123 update')).toEqual([]);
    expect(freshserviceTicketNumbers('Re: [CASE-249123] Dell support')).toEqual([]);
    expect(freshserviceTicketNumbers('Re: CASE-250117 Dell support')).toEqual([]);
  });

  test.each([
    ['Re: [CASE-251037] Invoice 4471 from a vendor', [251037]],
    ['RE: [#CASE-250924] payment run question', [250924]],
    ['Fw: [CASE-250659] and [INC-243414]', [250659, 243414]],
  ])('Accounting (CASE): %s', (subject, expected) => {
    expect(freshserviceTicketNumbers(subject, { extraPrefixes: ['CASE'] })).toEqual(expected);
  });

  test('with the prefix, only the bracketed form FreshService writes counts', () => {
    expect(freshserviceTicketNumbers('Microsoft Case #CASE-249123', { extraPrefixes: 'CASE' })).toEqual([]);
    expect(freshserviceTicketNumbers('Case study for UPCASE-12345 and CASE 77812', { extraPrefixes: 'CASE' })).toEqual([]);
  });

  test('prefix setting values are cleaned', () => {
    expect(parseTicketPrefixes('case, REQ;  x1')).toEqual(['CASE', 'REQ']);
    expect(parseTicketPrefixes(null)).toEqual([]);
    expect(parseTicketPrefixes(['CASE', 'CASE'])).toEqual(['CASE']);
  });
});
