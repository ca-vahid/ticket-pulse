/** PII scrubber for text that becomes shared knowledge (Auto-help P1). Every rule both ways. */
import {
  ACCOUNT_MARK, ADDRESS_MARK, CARD_MARK, EMAIL_MARK, ID_MARK, IP_MARK, LINK_MARK, MAC_MARK, MEETING_MARK, PHONE_MARK, SECRET_MARK,
  TICKET_MARK, containsPii, nameVariants, scrubPii,
} from '../src/utils/piiScrubber.js';

const PEOPLE = [
  { name: 'Sam Lee', email: 'sam.lee@example.com', role: 'requester' },
  { name: 'Mehdi Karimi', role: 'agent' },
];

describe('e-mail addresses', () => {
  test('removed with a marker (also mailto:)', () => {
    const out = scrubPii('Mail sam.lee@example.com or mailto:it@corp.example.ca today', { people: PEOPLE });
    expect(out).toBe(`Mail ${EMAIL_MARK} or ${EMAIL_MARK} today`);
    expect(containsPii(out)).toBe(false);
  });
  test('an @ that is not an address stays', () => {
    expect(scrubPii('Meet @ 3pm in room B')).toBe('Meet @ 3pm in room B');
  });
});

describe('phone numbers and extensions', () => {
  test.each([
    '+1 (604) 555-0199',
    '+1 (604) 555 0101',
    '604-555-0101',
    '604.555.0199',
    '604 555 0199 ext. 12',
    '+44 20 7946 0958',
    '6045550199',
    '555-0101',
    'ext 4521',
    'ext. 12',
    'extension 300',
    'x4521',
  ])('removes %s, also before a full stop', (phone) => {
    expect(scrubPii(`Call ${phone}.`)).toBe(`Call ${PHONE_MARK}.`);
  });

  test('a number and its extension collapse to one marker', () => {
    expect(scrubPii('Call 604-555-0101 x4521 today')).toBe(`Call ${PHONE_MARK} today`);
  });

  test('keeps versions, dates, KB numbers, builds, ports, hex codes and model names', () => {
    const text = 'Revit 2025 (16.0.1, KB5034441) on 2026-09-25, build 10.0.19045.1234 port 8080, error 0x80070005, ThinkPad x1 Carbon, 1,250 users.';
    expect(scrubPii(text)).toBe(text);
    expect(containsPii(text)).toBe(false);
  });
});

describe('IP addresses', () => {
  test('IPv4 with or without a port or mask is removed', () => {
    const out = scrubPii('Ping 10.0.0.12, then 192.168.1.1:8080 and 172.16.0.0/12.');
    expect(out).toBe(`Ping ${IP_MARK}, then ${IP_MARK} and ${IP_MARK}.`);
    expect(containsPii('host 10.0.0.12')).toBe(true);
  });
  test('three-part versions and out-of-range dotted numbers stay', () => {
    expect(scrubPii('Update to 16.0.1 (build 10.0.19045.1234), not 999.1.1.1')).toBe('Update to 16.0.1 (build 10.0.19045.1234), not 999.1.1.1');
  });
});

describe('secrets in links and text', () => {
  test('a sensitive query string is cut, the page stays', () => {
    expect(scrubPii('Open https://x.sharepoint.com/sites/a?sv=2020&sig=abcDEF123 now.')).toBe('Open https://x.sharepoint.com/sites/a now.');
    expect(scrubPii('See https://app.example.com/cb?code=abc&state=1')).toBe('See https://app.example.com/cb');
    expect(scrubPii('Go to https://app.example.com/#access_token=abc.def')).toBe('Go to https://app.example.com/');
  });
  test('a token-looking path or credentials in the URL remove the whole link', () => {
    expect(scrubPii('Reset: https://login.example.com/reset/3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b')).toBe(`Reset: ${LINK_MARK}`);
    expect(scrubPii('ftp via https://bob:hunter2@files.example.com/x')).toBe(`ftp via ${LINK_MARK}`);
  });
  test('ordinary links keep their query', () => {
    const text = 'Docs at https://learn.microsoft.com/en-us/windows?view=all and https://portal.example.com/apps/install-guide.';
    expect(scrubPii(text)).toBe(text);
  });
  test('password / token pairs and JWTs lose the value', () => {
    expect(scrubPii('Temp password: Hunter2! then change it')).toBe(`Temp password: ${SECRET_MARK} then change it`);
    expect(scrubPii('api_key=sk_live_123 and token is abc123')).toBe(`api_key=${SECRET_MARK} and token is ${SECRET_MARK}`);
    expect(scrubPii('Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U')).toBe(`Bearer ${SECRET_MARK}`);
  });
  test('the words alone are fine', () => {
    expect(scrubPii('Reset your password from the portal; the token expires daily.')).toBe('Reset your password from the portal; the token expires daily.');
  });
});

describe('street addresses (best effort)', () => {
  test('a street line with suite, city, province and postal code goes', () => {
    expect(scrubPii('Ship it to 1055 West Hastings Street, Suite 500, Vancouver, BC V6E 3T5.')).toBe(`Ship it to ${ADDRESS_MARK}.`);
    expect(scrubPii('Office: 12 Main St.')).toBe(`Office: ${ADDRESS_MARK}`);
  });
  test('steps with numbers are not addresses', () => {
    const text = 'Step 2: open Settings. Wait 5 minutes and restart Windows.';
    expect(scrubPii(text)).toBe(text);
  });
});

describe('ticket references', () => {
  test('TP-, #, ServiceNow-style and "ticket 123456" become "a previous ticket"', () => {
    expect(scrubPii('Same as TP-1234 and #241406.')).toBe(`Same as ${TICKET_MARK} and ${TICKET_MARK}.`);
    expect(scrubPii('See INC0012345 or RITM0045678.')).toBe(`See ${TICKET_MARK} or ${TICKET_MARK}.`);
    expect(scrubPii('As in ticket 242611 and ticket #88123.')).toBe(`As in ${TICKET_MARK} and ${TICKET_MARK}.`);
  });
  test('ordinary numbers and words stay', () => {
    expect(scrubPii('Open a ticket if 2 steps fail; issue #12 on the list.')).toBe('Open a ticket if 2 steps fail; issue #12 on the list.');
  });
});

describe('people passed in', () => {
  test('full name, then name parts, any capitalisation, whole words', () => {
    const out = scrubPii('Sam Lee asked; LEE said Samsung is fine. Mehdi fixed it.', { people: PEOPLE });
    expect(out).toBe('the requester asked; the requester said Samsung is fine. the agent fixed it.');
  });
  test('a name that is also a common word is only replaced where it is capitalised', () => {
    const people = [{ name: 'Will Mark', role: 'agent' }];
    expect(scrubPii('I will mark this done', { people })).toBe('I will mark this done');
    expect(scrubPii('Will Mark fixed it. Mark said ok.', { people })).toBe('the agent fixed it. the agent said ok.');
  });
});

describe('names nobody passed in', () => {
  test('greeting and same-line sign-off drop the name, not ordinary words', () => {
    expect(scrubPii('Hi Jordan,\nPlease install it.\nThanks, Jordan')).toBe('Hi,\nPlease install it.\nThanks');
    expect(scrubPii('Hello world. Thanks again, and hi team.')).toBe('Hello world. Thanks again, and hi team.');
    expect(scrubPii('Good morning Alex Smith,')).toBe('Good morning,');
  });
  test('a sign-off followed by a name on its own line', () => {
    expect(scrubPii('It works now.\nThanks,\nJohn Smith')).toBe('It works now.\nThanks,');
    expect(scrubPii('Done.\nRegards,\n\nPriya\nIT Manager')).toBe('Done.\nRegards,\nIT Manager');
  });
  test('a sign-off followed by an instruction or the team name stays', () => {
    expect(scrubPii('Thanks.\nOpen Settings')).toBe('Thanks.\nOpen Settings');
    expect(scrubPii('Thanks,\nIT Service Desk')).toBe('Thanks,\nIT Service Desk');
  });
  test('a common first name with a capitalised surname', () => {
    expect(scrubPii('Ask Priya Shah about it')).toBe('Ask the person about it');
    expect(scrubPii('Copied from Kevin Lam\'s laptop')).toBe('Copied from the person\'s laptop');
  });
  test('a first name before a lowercase word or a product name stays', () => {
    expect(scrubPii('Install Microsoft Teams and Adobe Reader')).toBe('Install Microsoft Teams and Adobe Reader');
    expect(scrubPii('the nick in the cable')).toBe('the nick in the cable');
  });
  test('a subject segment that is only a name', () => {
    expect(scrubPii('NIck stone - EUROPE move')).toBe('EUROPE move');
    expect(scrubPii('Europe move - Nick Stone')).toBe('Europe move');
    expect(scrubPii('VPN - cannot connect')).toBe('VPN - cannot connect');
  });
});

describe('clean-up', () => {
  test('collapses what the removals leave behind', () => {
    expect(scrubPii('Sam Lee Sam Lee (sam.lee@example.com)', { people: PEOPLE })).toBe(`the requester (${EMAIL_MARK})`);
    expect(scrubPii('')).toBe('');
    expect(scrubPii(null)).toBe('');
  });
  test('nameVariants: full name first, parts of 3+ letters, never an e-mail', () => {
    expect(nameVariants('Jo Ann Smith')).toEqual(['Jo Ann Smith', 'Smith', 'Ann']);
    expect(nameVariants('x@y.com')).toEqual([]);
  });
});

describe('re-audit round 2', () => {
  test('honorific + surname', () => {
    expect(scrubPii('Mr. Tanaka called; ask Dr. Kowalczyk or Ms Lee.')).toBe('the person called; ask the person or the person.');
    expect(scrubPii('Drive D: is full; Mrs is an abbreviation.')).toBe('Drive D: is full; Mrs is an abbreviation.');
  });

  test('a lone capitalised common first name', () => {
    expect(scrubPii('Mehdi confirmed it works.')).toBe('the person confirmed it works.');
    expect(scrubPii('Thanks Priya for the fix')).toBe('Thanks the person for the fix');
    expect(scrubPii('It works, Priya.')).toBe('It works, the person.');
  });

  test('sentence-start words and product / place names are not names', () => {
    const text = 'Grant access to the share. Open Settings. Close the window. Grace period is 30 days. Ask Alexa. Victoria office. Mark as done.';
    expect(scrubPii(text)).toBe(text);
    expect(scrubPii('I will mark it; the bill is due; mehdi in lower case stays.')).toBe('I will mark it; the bill is due; mehdi in lower case stays.');
  });

  test('secrets with and without a separator', () => {
    expect(scrubPii('my pass: Secret123')).toBe(`my pass: ${SECRET_MARK}`);
    expect(scrubPii('passphrase = horse')).toBe(`passphrase = ${SECRET_MARK}`);
    expect(scrubPii('password BlueHorse then log in')).toBe(`password ${SECRET_MARK} then log in`);
    expect(scrubPii('Wifi key: abc12345')).toBe(`Wifi key: ${SECRET_MARK}`);
    expect(scrubPii('PIN 4412 at the door')).toBe(`PIN ${SECRET_MARK} at the door`);
  });

  test('secret words without a secret stay', () => {
    const text = 'Open Password Manager, do a password reset, then pick a PIN you like.';
    expect(scrubPii(text)).toBe(text);
  });

  test.each(['07700 900123', '555 0101', '604/555/0199'])('removes the phone number %s', (phone) => {
    expect(scrubPii(`Call ${phone} today`)).toBe(`Call ${PHONE_MARK} today`);
  });

  test('seven bare digits only after a phone cue', () => {
    expect(scrubPii('Call 5550101.')).toBe(`Call ${PHONE_MARK}.`);
    expect(scrubPii('Build 1234567 and KB5034441')).toBe('Build 1234567 and KB5034441');
  });

  test('SSN / SIN shapes', () => {
    expect(scrubPii('SSN 123-45-6789, SIN 123 456 789 and 046-454-286.')).toBe(`SSN ${ID_MARK}, SIN ${ID_MARK} and ${ID_MARK}.`);
    expect(scrubPii('Released 2026-09-25, v1.2.3')).toBe('Released 2026-09-25, v1.2.3');
  });

  test('card numbers go entirely, no group left behind', () => {
    for (const card of ['4111 1111 1111 1111', '4111-1111-1111-1111', '4111111111111111', '3782 822463 10005']) {
      expect(scrubPii(`Card ${card} ok`)).toBe(`Card ${CARD_MARK} ok`);
    }
  });

  test('sign-in names: no-TLD addresses and Windows logons', () => {
    expect(scrubPii('mail jdoe@corp now')).toBe(`mail ${ACCOUNT_MARK} now`);
    expect(scrubPii('log in as BGC\\jdoe or BGC\\\\jdoe')).toBe(`log in as ${ACCOUNT_MARK} or ${ACCOUNT_MARK}`);
    expect(scrubPii('jane@example.com')).toBe(EMAIL_MARK);
  });

  test('paths and registry keys are not sign-ins', () => {
    const text = 'Open C:\\Windows\\System32\\drivers and HKLM\\Software\\Microsoft; meet @ 3pm.';
    expect(scrubPii(text)).toBe(text);
  });

  test('SR / REQ / CHG references, with or without a space', () => {
    expect(scrubPii('See SR 12345, REQ12345 and CHG0012345.')).toBe(`See ${TICKET_MARK}, ${TICKET_MARK} and ${TICKET_MARK}.`);
    expect(scrubPii('SRS 2 and CHG in 3 steps')).toBe('SRS 2 and CHG in 3 steps');
  });
});

describe('re-audit round 3', () => {
  const R = SECRET_MARK;

  test.each([
    ['key sk-proj-abcDEF1234567890abcdef1234', `key ${R}`],
    ['AWS AKIAIOSFODNN7EXAMPLE and ASIAIOSFODNN7EXAMPLE', `AWS ${R} and ${R}`],
    ['aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', `aws_secret_access_key = ${R}`],
    ['token 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 here', `token ${R} here`],
    ['blob Zk9vQmFyQmF6MTIzNDU2Nzg5MGFiY2RlZmdoaWo in the log', `blob ${R} in the log`],
    ['Authorization: Bearer abc.def-ghi_123', `Authorization: Bearer ${R}`],
    ['use ghp_abcdefghijklmnopqrstuvwxyz0123456789 or gho_abcdefghijklmnopqrstuvwxyz01', `use ${R} or ${R}`],
    ['slack xoxb-1234567890-abcdefghij', `slack ${R}`],
    ['pw is Spring2026!', `pw is ${R}`],
    ['the password was hunter2 yesterday', `the password was ${R} yesterday`],
    ['password is BlueHorse', `password is ${R}`],
    ['pwd: S3cr3t!', `pwd: ${R}`],
    ['passphrase: correct horse battery staple. Then log in.', `passphrase: ${R}. Then log in.`],
  ])('secret: %s', (input, expected) => {
    expect(scrubPii(input)).toBe(expected);
  });

  test('secret words, file names and GUIDs without a secret stay', () => {
    const text = 'The password is reset every 90 days; the password was changed. Project_2025_Final_Report_Version3_Draft_v2.docx, GUID 123e4567-e89b-12d3-a456-426614174000.';
    expect(scrubPii(text)).toBe(text);
  });

  test('share links and sensitive query params', () => {
    expect(scrubPii('https://bgc.sharepoint.com/:x:/r/sites/IT/Shared%20Documents/a.xlsx?d=w123&e=AbCdEf'))
      .toBe('https://bgc.sharepoint.com/:x:/r/sites/IT/Shared%20Documents/a.xlsx');
    expect(scrubPii('See https://bgc-my.sharepoint.com/:w:/g/personal/jdoe_bgc_ca/EaBcDe?e=xYz now')).toBe(`See ${LINK_MARK} now`);
    for (const q of ['e=abc', 'sig=abc', 'token=abc', 'code=abc', 'key=abc', 'secret=abc']) {
      expect(scrubPii(`https://x.example.com/p?${q}&page=2`)).toBe('https://x.example.com/p');
    }
    expect(scrubPii('https://x.example.com/p?page=2&view=all')).toBe('https://x.example.com/p?page=2&view=all');
  });

  test.each([
    'Ship to 221B Baker Street, London NW1 6XE',
    'Office 500-1045 Howe St, Vancouver',
    'Vancouver BC V6Z 2A9',
    'Seattle, WA 98101-1234',
    '12 rue de la Paix, 75002 Paris',
  ])('address: %s', (addr) => {
    const out = scrubPii(`${addr} today`);
    expect(out).toMatch(/\[address removed\] today$/);
    expect(out).not.toMatch(/\d/);
  });

  test('labelled ids, IPv6, MAC, obfuscated e-mails, 00 prefixes, meeting ids', () => {
    expect(scrubPii('Employee ID: E12345, badge 44821, passport number GB1234567')).toBe(`Employee ID: ${ID_MARK}, badge ${ID_MARK}, passport number ${ID_MARK}`);
    expect(scrubPii('fe80::1ff:fe23:4567:890a and 2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toBe(`${IP_MARK} and ${IP_MARK}`);
    expect(scrubPii('MAC 00:1A:2B:3C:4D:5E or 00-1a-2b-3c-4d-5e or 0011.2233.4455')).toBe(`MAC ${MAC_MARK} or ${MAC_MARK} or ${MAC_MARK}`);
    expect(scrubPii('mail jdoe(at)bgc(dot)com or jdoe [at] bgc [dot] ca')).toBe(`mail ${EMAIL_MARK} or ${EMAIL_MARK}`);
    expect(scrubPii('Call 0044 20 7946 0958 or 001 604 555 0199.')).toBe(`Call ${PHONE_MARK} or ${PHONE_MARK}.`);
    expect(scrubPii('Meeting ID: 912 3456 7890, Zoom ID 91234567890')).toBe(`${MEETING_MARK}, ${MEETING_MARK}`);
  });

  test('look-alikes stay: member of, std::, times, versions', () => {
    const text = 'A member of the team fixed std::string at 10:30:00 in build 10.0.19045; badge reader offline.';
    expect(scrubPii(text)).toBe(text);
  });

  test('two-letter surnames, initials, and passed-in names in any case', () => {
    expect(scrubPii('Susan Xu and Mr Ng called')).toBe('the person and the person called');
    expect(scrubPii('J. Smith approved')).toBe('the person approved');
    const people = [{ name: 'Susan Xu', role: 'person' }];
    expect(scrubPii('susan xu called; XU said yes', { people })).toBe('the person called; the person said yes');
  });

  test('no over-scrubbing of words, initials in lists, or common-word names', () => {
    const people = [{ name: 'Will Mark', role: 'agent' }, { name: 'Bill Hall', role: 'agent' }];
    const text = 'I will mark this done. Grant access, pay the bill. Open Settings. Close the window. Option A. Click Next. Step 3. Open Teams. U.S. Army.';
    expect(scrubPii(text, { people })).toBe(text);
  });
});
