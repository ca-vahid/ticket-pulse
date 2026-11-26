/**
 * `{{ ticket.freshserviceTicketId }}` in a workflow e-mail (26 Nov 2026): it is
 * blank on every Ticket Pulse-born ticket, so Accounting's acknowledgements read
 * "Ticket received: #". The editor warns and offers a one-click swap to the
 * ticket number, `{{ ticket.displayRef }}` ("TP-13662", or the FreshService
 * number on a FreshService ticket).
 */
const USES = /ticket\.freshserviceTicketId\b/;

/** True when any of the given template strings reads the FreshService id. */
export function usesFsTicketId(...values) {
  return values.some((v) => USES.test(String(v || '')));
}

/**
 * The same text with the ticket number instead. A "#" written just before the
 * variable goes too: displayRef already reads "TP-13662" or "#253328".
 */
export function swapFsTicketId(value) {
  if (value === null || value === undefined) return value;
  return String(value)
    .replace(/#\s*(\{\{-?\s*ticket\.freshserviceTicketId\b)/g, '$1')
    .replace(/(\{\{-?\s*)ticket\.freshserviceTicketId\b/g, '$1ticket.displayRef');
}
