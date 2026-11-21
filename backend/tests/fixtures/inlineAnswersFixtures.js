/**
 * Inline-answer fixtures (20 Nov 2026). Invented people and example.com only.
 * Modelled on a real Outlook reply: the agent asked three numbered questions,
 * the requester typed an answer under each one inside the quote (yellow
 * highlight) and wrote only "Please see below highlight." at the top.
 */

const P = (text) => `<p class="MsoNormal"><span style="font-size:11.0pt;font-family:&quot;Calibri&quot;,sans-serif">${text}<o:p></o:p></span></p>`;
const HL = (text) => `<span style="background:yellow;mso-highlight:yellow">${text}</span>`;

const Q1 = '1. Is it OK if we remove the partial copy in the portal and start fresh?';
const Q2 = '2. Should all three folders go to the client, or only some?';
const Q3 = '3. The workbook has Review Notes, Critical and Partner tabs. Should the client see those, or should we publish a version without them?';

/** The agent's reply as Ticket Pulse stored it (composer HTML). */
export const SENT_HTML = [
  '<p>Hi Priya,</p>',
  '<p>I am picking this ticket up from Sam. I had a look at both sites and can explain what happened.</p>',
  '<p>The metadata did not come across because the portal library does not have the columns you use on the project hub. SharePoint only carries values across for columns that exist in both libraries, so they were dropped during the copy. Your files on the hub are untouched.</p>',
  '<p>We can do this for you. The plan would be to add the matching columns, redo the copy, and repoint the portal copy of the workbook.</p>',
  '<p>Three questions before we start:</p>',
  `<p>${Q1}</p>`,
  `<p>${Q2}</p>`,
  `<p>${Q3}</p>`,
  '<p>We are also raising this with the records team so there is a proper long term home for registers like this one.</p>',
  '<p>Thanks,</p>',
  '<p>Dana</p>',
].join('');

export const SENT_SIGNATURE_TEXT = 'Dana Fox\nIT Coordinator';

/** The quote header block Outlook desktop writes (grey rule + From/Sent/To/Cc/Subject). */
const OUTLOOK_HEADER = '<div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0in 0in 0in">'
  + '<p class="MsoNormal"><b><span style="font-size:11.0pt">From:</span></b><span style="font-size:11.0pt"> Dana Fox &lt;it@example.com&gt; <br>'
  + '<b>Sent:</b> Friday, November 20, 2026 3:03 PM<br>'
  + '<b>To:</b> Priya Nair &lt;priya.nair@example.com&gt;<br>'
  + '<b>Cc:</b> Sam Okafor &lt;sam.okafor@example.com&gt;<br>'
  + '<b>Subject:</b> RE: Sharing the project library with the client [TP-4321]<o:p></o:p></span></p></div>';

/** The agent's message as Outlook re-renders it inside the quote, with optional insertions after each question. */
function quotedMessage({ a1 = '', a2 = '', a3 = '' } = {}) {
  return [
    P('Hi Priya,'),
    P('<o:p>&nbsp;</o:p>'),
    P('I am picking this ticket up from Sam. I had a look at both sites and can explain what happened.'),
    P('The metadata did not come across because the portal library does not have the columns you use on the project hub. SharePoint only carries values across for columns that exist in both libraries, so they were dropped during the copy. Your files on the hub are untouched.'),
    P('We can do this for you. The plan would be to add the matching columns, redo the copy, and repoint the portal copy of the workbook.'),
    P('Three questions before we start:'),
    P(`${Q1}${a1}`),
    P(`${Q2}${a2}`),
    P(`${Q3}${a3}`),
    P('We are also raising this with the records team so there is a proper long term home for registers like this one.'),
    P('Thanks,'),
    P('Dana'),
    P('Dana Fox'),
    P('IT Coordinator'),
  ].join('');
}

const DISCLAIMER = '<p class="MsoNormal"><span style="font-size:7.0pt;color:#A6A6A6">Privacy notice: this message is confidential and intended only for the addressee.</span></p>';
const HIDDEN_REF = '<div style="font-size:0px;color:#ffffff"><span style="line-height:0px">[TP-4321]:ref:hidden</span></div>';

/** Outlook desktop (WordSection1) reply with the three answers typed inside the quote. */
export const REPLY_INLINE_DESKTOP = '<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><style><!-- p.MsoNormal {margin:0in;} --></style></head>'
  + '<body lang="EN-US" link="#0563C1"><div class="WordSection1">'
  + P(`Thank you so much Dana. Please see below ${HL('highlight')}.`)
  + P('<o:p>&nbsp;</o:p>')
  + P('Priya')
  + P('<o:p>&nbsp;</o:p>')
  + OUTLOOK_HEADER
  + P('<o:p>&nbsp;</o:p>')
  + quotedMessage({
    a1: ` ${HL('OK to proceed.')}`,
    a2: ` ${HL('All three')}`,
    a3: ` ${HL('Only the query page, so they can filter however they want and grab files easily.')}`,
  })
  + DISCLAIMER
  + HIDDEN_REF
  + '</div></body></html>';

/** Outlook on the web shape: appendonsend + rule + bold From block, then the quote. */
export const REPLY_INLINE_WEB = '<html><head><style type="text/css" style="display:none">p {margin-top:0;margin-bottom:0}</style></head><body dir="ltr">'
  + '<div class="elementToProof" style="font-family:Aptos,sans-serif;font-size:11pt;color:rgb(0,0,0)">Thank you so much Dana. Please see below <span class="spanWithBackgroundColor" style="background-color:rgb(255,255,0)">highlight</span>.&nbsp;</div>'
  + '<div id="appendonsend"></div><div><br></div><div class="elementToProof">Priya</div>'
  + '<hr style="display:inline-block;width:98%"><div><b>From:</b> Dana Fox &lt;it@example.com&gt;<br><b>Sent:</b> Friday, November 20, 2026 3:03 PM<br><b>To:</b> Priya Nair &lt;priya.nair@example.com&gt;<br><b>Subject:</b> Re: Sharing the project library with the client</div>'
  + '<div><br></div>'
  + '<div>Hi Priya,</div><div><br></div>'
  + '<div>I am picking this ticket up from Sam. I had a look at both sites and can explain what happened.</div>'
  + '<div>The metadata did not come across because the portal library does not have the columns you use on the project hub. SharePoint only carries values across for columns that exist in both libraries, so they were dropped during the copy. Your files on the hub are untouched.</div>'
  + '<div>We can do this for you. The plan would be to add the matching columns, redo the copy, and repoint the portal copy of the workbook.</div>'
  + '<div>Three questions before we start:</div>'
  + `<div class="elementToProof">${Q1} <span class="spanWithBackgroundColor" style="background-color:rgb(255,255,0)">OK to proceed.</span></div>`
  + `<div class="elementToProof">${Q2} <span class="spanWithBackgroundColor" style="background-color:rgb(255,255,0)">All three</span></div>`
  + `<div class="elementToProof">${Q3} <span class="spanWithBackgroundColor" style="background-color:rgb(255,255,0)">Only the query page, so they can filter however they want and grab files easily.</span></div>`
  + '<div>We are also raising this with the records team so there is a proper long term home for registers like this one.</div>'
  + '<div><br></div><div>Thanks,</div><div>Dana</div>'
  + '<blockquote><div>On Wed, 18 Nov 3:19 PM, Priya Nair &lt;priya.nair@example.com&gt; wrote:</div><div>I noticed the metadata on each file is not transferred when I copy the files to the portal. Is there a way to keep it?</div></blockquote>'
  + HIDDEN_REF
  + DISCLAIMER
  + '</body></html>';

/** Top-posted reply; the quote is our message unchanged. */
export const REPLY_TOP_POSTED = '<html><body><div class="WordSection1">'
  + P('Thanks Dana, all three folders please, and go ahead with a fresh copy.')
  + P('Priya')
  + OUTLOOK_HEADER
  + quotedMessage()
  + DISCLAIMER
  + '</div></body></html>';

/** A reply whose quote is some older message we cannot match with the agent's reply. */
export const REPLY_OLDER_MESSAGE = '<html><body><div class="WordSection1">'
  + P('Following up on this one.')
  + '<div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0in 0in 0in"><p class="MsoNormal"><b>From:</b> Priya Nair &lt;priya.nair@example.com&gt;<br><b>Sent:</b> Monday, November 16, 2026 9:12 AM<br><b>To:</b> IT &lt;it@example.com&gt;<br><b>Subject:</b> Sharing the project library with the client</p></div>'
  + P('Hello team,')
  + P('I noticed that the metadata assigned to each file is not transferred when I copy the files to the client portal.')
  + P(`Is there a way to copy the files with their metadata? ${HL('This is urgent for Monday.')}`)
  + P('The project hub has about thirteen hundred historical documents and a master workbook that links to them.')
  + P('Regards,')
  + P('Priya')
  + '</div></body></html>';

/** The answer to question 2 runs over two paragraphs under the question. */
export const REPLY_TWO_LINE_ANSWER = '<html><body><div class="WordSection1">'
  + P(`Please see my answer ${HL('below')}.`)
  + OUTLOOK_HEADER
  + quotedMessage({
    a2: '</span></p><p class="MsoNormal"><span style="background:yellow;mso-highlight:yellow">All three, please.</span></p><p class="MsoNormal"><span style="background:yellow;mso-highlight:yellow">Keep the folder names as they are on the hub.</span><span>',
  })
  + '</div></body></html>';

/** Plain-text reply: ">" prefixes, the quote re-wrapped at a different width, answers on their own lines. */
export const REPLY_PLAIN_TEXT = [
  'Thanks Dana, answers below.',
  '',
  'Priya',
  '',
  'On Fri, Nov 20, 2026 at 3:03 PM Dana Fox <it@example.com> wrote:',
  '> Hi Priya,',
  '>',
  '> I am picking this ticket up from Sam. I had a look at both sites and',
  '> can explain what happened.',
  '>',
  '> The metadata did not come across because the portal library does not',
  '> have the columns you use on the project hub. SharePoint only carries',
  '> values across for columns that exist in both libraries, so they were',
  '> dropped during the copy. Your files on the hub are untouched.',
  '>',
  '> We can do this for you. The plan would be to add the matching',
  '> columns, redo the copy, and repoint the portal copy of the workbook.',
  '>',
  '> Three questions before we start:',
  '> 1. Is it OK if we remove the partial copy in the portal and start',
  '> fresh?',
  'Yes, go ahead.',
  '> 2. Should all three folders go to the client, or only',
  '> some?',
  'Only the first two.',
  '> 3. The workbook has Review Notes, Critical and Partner tabs. Should',
  '> the client see those, or should we publish a version without them?',
  '>',
  '> We are also raising this with the records team so there is a proper',
  '> long term home for registers like this one.',
  '>',
  '> Thanks,',
  '> Dana',
].join('\r\n');

export const SENT_TEXT = [
  'Hi Priya,',
  '',
  'I am picking this ticket up from Sam. I had a look at both sites and can explain what happened.',
  '',
  'The metadata did not come across because the portal library does not have the columns you use on the project hub. SharePoint only carries values across for columns that exist in both libraries, so they were dropped during the copy. Your files on the hub are untouched.',
  '',
  'We can do this for you. The plan would be to add the matching columns, redo the copy, and repoint the portal copy of the workbook.',
  '',
  'Three questions before we start:',
  Q1,
  Q2,
  Q3,
  '',
  'We are also raising this with the records team so there is a proper long term home for registers like this one.',
  '',
  'Thanks,',
  'Dana',
].join('\n');

export const EXPECTED_CONTEXTS = [
  'Is it OK if we remove the partial copy in the portal and start fresh?',
  'Should all three folders go to the client, or only some?',
  '…Should the client see those, or should we publish a version without them?',
];
