/**
 * Fixtures for the public approval page (/approval/:token) — the contract the
 * backend exposes on GET /api/ticket-approvals/public/:token. Shared by the
 * unit tests and the qa/evidence capture script (which stubs the API with
 * these when no backend is running). Plain data, no JSX.
 */

const CREATED_AT = '2026-08-28T16:05:00.000Z';
const SENT_AT = '2026-09-01T21:14:00.000Z';
const DUE_AT = '2026-09-04T22:00:00.000Z';
const EXPIRES_AT = '2026-10-01T21:14:00.000Z';

export const REQUEST_NOTE_HTML = `
<p>Ingrid's laptop has failed repeatedly over six months. Requesting a replacement — quote below (CAD, incl. tax):</p>
<table class="tp-data-table">
  <tr><th>Qty</th><th>Part</th><th>Vendor</th><th>Model</th><th>Location</th><th>CPU</th><th>Graphics</th><th>RAM</th><th>Unit price</th></tr>
  <tr><td>1</td><td>MP2V5N1L</td><td>Lenovo</td><td>Yoga Slim 7i Ultra Aura Edition (14″ Intel) – White</td><td>Vancouver</td><td>Intel® Core™ Ultra 7 355</td><td>Integrated Graphics</td><td>32 GB</td><td><b>$2,149.00</b></td></tr>
</table>`;

export const DESCRIPTION_HTML = `
<p>Hi, I hope you're doing well. Over the past six months, I've been experiencing ongoing issues with my laptop. It frequently shuts down on its own and can be very slow, especially during startup. At times, it takes more than 10 minutes to turn on, and I often need to perform a hard shutdown before I can log in.</p>
<p>These issues have become more frequent over the last few weeks and have started affecting my work. For example, my laptop has unexpectedly shut down during team or client meetings on a number of occasions, and I have lost unsaved work twice.</p>
<p>I have already tried the steps suggested by the help desk (driver updates, a BIOS refresh and a clean Windows reinstall) without a lasting improvement. Could you please look into a replacement or a more permanent fix?</p>
<p>Thank you for your help,<br>Ingrid</p>`;

export const DESCRIPTION_TEXT = 'Hi, I hope you\'re doing well. Over the past six months, I\'ve been experiencing ongoing issues with my laptop. It frequently shuts down on its own and can be very slow, especially during startup.';

const ticket = {
  id: 239934,
  displayRef: '#239934',
  subject: 'Laptop Stability and Performance Concerns',
  status: 'Open',
  priority: 2,
  priorityLabel: 'Medium',
  ticketType: 'Service Request',
  categoryPath: 'Devices & Hardware › Laptop procurement',
  createdAt: CREATED_AT,
  dueBy: DUE_AT,
  descriptionHtml: DESCRIPTION_HTML,
  descriptionText: DESCRIPTION_TEXT,
  requester: {
    name: 'Ingrid Berru Garcia',
    email: 'iberrugarcia@bgcengineering.ca',
    title: 'Geotechnical Engineer',
    department: 'Geotechnical',
    location: 'Vancouver',
    photoUrl: null,
  },
  workspace: { name: 'IT', slug: 'it' },
  appTicketUrl: 'https://ticketpulse.bgcsaas.com/tickets/239934',
};

const baseApproval = {
  id: 501,
  status: 'pending',
  approverEmail: 'ingrid.manager@bgcengineering.ca',
  approverName: 'Dana Whitfield',
  requestedByEmail: 'mblackstock@bgcengineering.ca',
  requestedByName: 'Marcus Blackstock',
  requestedByPhotoUrl: null,
  requestNote: 'Ingrid\'s laptop has failed repeatedly over six months. Requesting a replacement — quote below (CAD, incl. tax).',
  requestNoteHtml: REQUEST_NOTE_HTML,
  createdAt: SENT_AT,
  expiresAt: EXPIRES_AT,
  decidedAt: null,
  decidedVia: null,
  decisionNote: null,
  decisionNoteHtml: null,
  category: { name: 'Hardware purchase approval', description: 'Laptops, monitors and peripherals over $500.' },
  clarificationLog: [],
  supersededBy: null,
  cancelledReason: null,
};

const approvers = [
  { name: 'Dana Ruiz (Finance)', status: 'pending', isYou: false, decidedAt: null },
  { name: 'Dana Whitfield', status: 'pending', isYou: true, decidedAt: null },
];

const meta = { viewedAt: '2026-09-02T15:00:00.000Z' };

const build = (approvalPatch = {}, approverPatch = null, ticketPatch = {}) => ({
  approval: { ...baseApproval, ...approvalPatch },
  ticket: { ...ticket, ...ticketPatch },
  approvers: approverPatch || approvers,
  meta,
});

export const pendingFixture = build();

export const infoRequestedFixture = build({
  status: 'info_requested',
  clarificationLog: [
    {
      question: 'Is a refurbished unit an option?',
      askedBy: 'Dana Whitfield',
      askedAt: '2026-09-01T23:40:00.000Z',
      answer: 'No refurbished stock for this model; the quote is the standard config we deploy.',
      answeredBy: 'Marcus Blackstock',
      answeredAt: '2026-09-02T14:12:00.000Z',
    },
    {
      question: 'Does the price include the docking station?',
      askedBy: 'Dana Whitfield',
      askedAt: '2026-09-02T15:05:00.000Z',
      answer: null,
      answeredBy: null,
      answeredAt: null,
    },
  ],
});

export const approvedFixture = build(
  {
    status: 'approved',
    decidedAt: '2026-09-02T16:30:00.000Z',
    decidedVia: 'link',
    decisionNote: 'Approved — please order the 32 GB config.',
    decisionNoteHtml: '<p>Approved — please order the 32 GB config.</p>',
  },
  [
    { name: 'Dana Whitfield', status: 'approved', isYou: true, decidedAt: '2026-09-02T16:30:00.000Z' },
    { name: 'Dana Ruiz (Finance)', status: 'pending', isYou: false, decidedAt: null },
  ],
);

export const approvedInAppFixture = build(
  {
    status: 'approved',
    decidedAt: '2026-09-02T16:30:00.000Z',
    decidedVia: 'app',
    approverName: 'Priya Natarajan',
  },
  [
    { name: 'Dana Whitfield', status: 'approved', isYou: true, decidedAt: '2026-09-02T16:30:00.000Z' },
  ],
);

export const rejectedFixture = build(
  {
    status: 'rejected',
    decidedAt: '2026-09-02T16:30:00.000Z',
    decidedVia: 'link',
    decisionNote: 'Budget is frozen until Q4 — please re-submit in October.',
    decisionNoteHtml: null,
  },
  [
    { name: 'Dana Whitfield', status: 'rejected', isYou: true, decidedAt: '2026-09-02T16:30:00.000Z' },
  ],
);

export const cancelledFixture = build(
  {
    status: 'cancelled',
    cancelledReason: 'The requester found a spare unit in the Vancouver loaner pool.',
  },
  [
    { name: 'Dana Whitfield', status: 'cancelled', isYou: true, decidedAt: null },
    { name: 'Dana Ruiz (Finance)', status: 'cancelled', isYou: false, decidedAt: null },
  ],
);

export const supersededFixture = build(
  {
    status: 'cancelled',
    supersededBy: { name: 'Priya Natarajan', decidedAt: '2026-09-02T17:10:00.000Z' },
  },
  [
    { name: 'Dana Whitfield', status: 'superseded', isYou: true, decidedAt: null },
    { name: 'Priya Natarajan', status: 'approved', isYou: false, decidedAt: '2026-09-02T17:10:00.000Z' },
  ],
);

export const expiredError = { status: 400, data: { message: 'This approval link has expired.', requestedByName: 'Marcus Blackstock' } };
export const invalidError = { status: 404, data: { message: 'Approval not found' } };
