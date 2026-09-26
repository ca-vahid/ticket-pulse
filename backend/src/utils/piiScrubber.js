/**
 * PII scrubber for text that leaves a ticket and becomes shared knowledge
 * (Auto-help P1: articles drafted from solved tickets, "Turn into an
 * article", gap cluster titles). An article is read by everyone, so the
 * people in the source tickets must not be in it:
 *
 *   - e-mail addresses (also mailto: links)            -> [e-mail removed]
 *   - phone numbers: 10-digit and international shapes, 7-digit local
 *     numbers ("555-0101") and extensions ("ext 4521", "x4521")
 *                                                       -> [phone removed]
 *   - IPv4 addresses (with /mask or :port)              -> [IP removed]
 *   - secrets: token-looking URL paths, sensitive query strings / fragments
 *     (?token= &sig= #access_token=), JWTs, "password: ..." pairs
 *                                                       -> removed / [link removed]
 *   - street addresses (best effort: "1055 West Hastings Street, Suite 500")
 *                                                       -> [address removed]
 *   - SSN / SIN shapes ("123-45-6789", "123 456 789")  -> [ID removed]
 *   - card numbers, every group ("4111 1111 1111 1111") -> [card removed]
 *   - sign-in names: "jdoe@corp" (no TLD), "BGC\jdoe"   -> [account removed]
 *   - API keys / tokens: sk-…, AKIA/ASIA…, AWS secrets, ghp_/gho_…, xox…,
 *     "Bearer …", long base64 / hex runs; passwords in prose ("pw is …",
 *     "the password was …"; a passphrase to the end of its sentence)
 *                                                       -> [removed]
 *   - IPv6 / MAC addresses, employee / badge / passport numbers, postcodes
 *     (UK, Canada, US ZIP + state), French street addresses, unit-street
 *     ("500-1045 Howe St"), obfuscated e-mails "name(at)domain(dot)com",
 *     00-prefixed international numbers, meeting ids -> their markers
 *   - ticket references (TP-1234, #241406, INC0012345, "ticket 242611")
 *                                                       -> "a previous ticket"
 *   - the people passed in: full name, then each name part of 3+ letters, as
 *     whole words — but ONLY where the match starts with a capital letter, so
 *     an agent called "Will Mark" never turns "I will mark this done" into
 *     nonsense                                          -> "the requester" / "the agent" / "the person"
 *   - people NOT passed in (best effort):
 *       a greeting or sign-off naming someone ("Hi Sam," / "Thanks, Sam")
 *       a sign-off followed by a name on its own line ("Thanks,\nJohn Smith")
 *       a common first name followed by a capitalised surname ("ask Priya Shah")
 *       an honorific + surname ("Mr. Tanaka", "Dr. Kowalczyk", "Ms Lee")
 *       a capitalised common first name on its own ("Mehdi confirmed",
 *       "Thanks Priya") — the list leaves out everyday words (Will, Mark,
 *       Grant, Bill…) and names that are also places / products (Grace,
 *       Austin, Victoria, Alexa, Aurora…)
 *       a subject segment that is just a name ("Nick Stone - Europe move")
 *
 * Dates, version numbers ("16.0.1", "10.0.19045.1234") and short codes (a KB
 * number "KB5034441", a build number) are NOT phone numbers or IPs. It is a
 * scrubber, not a guarantee: drafted articles always land as drafts for a
 * person to check.
 */

const EMAIL_RE = /(?:mailto:)?[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// +1 (604) 555-0199 · 604-555-0199 · 604.555.0199 · 604 555 0199 ext. 12 ·
// +44 20 7946 0958 · 6045550199 (10+ bare digits). A leading + or at least
// two separator groups is required below 10 digits.
// Edges: not glued to a word or a dotted number ("16.0.1", "10.0.0.12"), but
// a sentence-ending full stop is fine.
const PHONE_RE = /(?<!\w|\d\.)(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-])\d{3,4}[\s.-]\d{3,4}(?:\s*(?:ext\.?|x|extension)\s*\d{1,6})?(?!\w|\.\d)|(?<!\w|\d\.|\+)\+\d[\d\s.-]{7,16}\d(?!\w|\.\d)|(?<![\w-]|\d\.)\d{10,13}(?!\w|\.\d)/gi;
// A 7-digit local number "555-0101" / "555.0101" (not part of a longer run,
// a date "2026-09-25" or a version).
const LOCAL_PHONE_RE = /(?<![\w.+/-]|\d[\s.-])\d{3}[-.]\d{4}(?![\w]|[.-]\d)/g;
// UK-style "07700 900123", "020 7946 0958"; slashes "604/555/0199"; local "555 0101".
const EXTRA_PHONE_RE = /(?<![\w.+/-])0\d{4}[ -]?\d{6}(?![\w]|[.-]\d)|(?<![\w.+/-])0\d{2,3}[ -]\d{3,4}[ -]\d{4}(?![\w]|[.-]\d)|(?<![\w./])\d{3}\/\d{3}\/\d{4}(?![\w/])|(?<![\w.+/-]|\d[ .-])\d{3} \d{4}(?![\w]|[ .-]\d)/g;
// Seven bare digits only after a phone cue ("call 5550101"): "build 1234567" stays.
const CUED_PHONE_RE = /\b(call|phone|tel|telephone|cell|mobile|text|number|reach (?:me|him|her|them) at)(\s*[:#]?\s*)\d{7}(?![\w]|[.-]\d)/gi;
// An extension on its own: "ext 4521", "ext. 12", "extension 300", "x4521".
const EXTENSION_RE = /(?<![\w.-])(?:ext\.?|extension)[ \t]*[#:]?[ \t]*\d{2,6}(?!\w)|(?<![\w.-])[xX]\d{3,6}(?!\w|\.\w)/gi;
const IPV4_RE = /(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\/\d{1,2})?(?::\d{1,5})?(?![\w]|\.\d)/g;
const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;
const JWT_RE = /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g;
const SECRET_PAIR_RE = /\b(password|passcode|passwd|pass|pwd|pw|pin|token|secret|api[ _-]?key|client[ _-]?secret|access[ _-]?key|wi-?fi (?:key|password)|network key)(\s*(?::|=)\s*|\s+(?:is|was|is now|was set to|is set to)\s+)([^\s,;]+)/gi;
// "password is reset every 90 days": after is / was, these words are not the password.
const NOT_A_SECRET_WORD = new Set(['reset', 'expired', 'expiring', 'changed', 'wrong', 'incorrect', 'correct', 'required', 'needed', 'the', 'a', 'an',
  'not', 'being', 'set', 'updated', 'sent', 'too', 'still', 'case', 'valid', 'invalid', 'locked', 'empty', 'blank', 'same', 'different', 'missing',
  'saved', 'stored', 'shared', 'emailed', 'texted', 'below', 'above', 'in', 'on', 'at', 'for', 'to', 'now', 'no', 'your', 'my', 'their', 'his', 'her',
  'working', 'accepted', 'rejected', 'forgotten', 'lost', 'unknown', 'weak', 'strong', 'long', 'short', 'protected', 'managed', 'synced', 'stale', 'old', 'new']);
// A passphrase is several words: everything after it to the end of the sentence / line.
const PASSPHRASE_RE = /\b(pass ?phrase)(\s*(?::|=)\s*|\s+(?:is|was)\s+)([^\n.;!?]+?)(?=[.;!?](?:\s|$)|\n|$)/gi;
// Well-known key / token shapes (anywhere, no label needed).
const API_TOKEN_RE = /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{16,}|\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bxox[abposr]-[A-Za-z0-9-]{10,}/g;
const BEARER_RE = /\b(Bearer)(\s+)[A-Za-z0-9._~+/=-]{6,}/g;
// A 40-character AWS secret near "secret" / aws_secret_access_key.
const AWS_SECRET_RE = /\b(aws_secret_access_key|secret(?:[ _-]?access)?(?:[ _-]?key)?)([^A-Za-z0-9/+\n]{1,12}|\s+(?:is|was)\s+)([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+=])/gi;
// Long base64 / hex runs (32+): tokens, not words. File names and GUIDs stay (checked in the callback).
const LONG_TOKEN_RE = /(?<![\w/.-])[A-Za-z0-9_+=-]{32,}(?![\w/.-])/g;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function looksLikeToken(m) {
  if (GUID_RE.test(m)) return false;
  if (/^[0-9a-f]{32,}$/i.test(m)) return true;
  if (!/\d/.test(m) || !/[A-Za-z]/.test(m)) return false;
  // "Project_2025_Final_Report_v3": two or more real words split by _ / - is a name, not a token.
  return m.split(/[_-]/).filter((w) => /^[A-Za-z]{3,}$/.test(w)).length < 2;
}
// Without a separator only when the value looks like a secret, not a word:
// "password BlueHorse" / "password hunter2!" / "PIN 4412" — not "password reset" or "Password Manager".
const SECRET_BARE_RE = /\b(password|passcode|pwd)([ \t]+)(?!is\b)([^\s,;:=][^\s,;]*)/gi;
const LOOKS_SECRET = /\d|[^\w]|[a-z][A-Z]/;
const PIN_RE = /\b(PIN|pin|Pin)([ \t]+(?:is[ \t]+|number[ \t]+|code[ \t]+)?)(\d{4,8})\b/g;
// A query/fragment parameter that carries a credential.
const SENSITIVE_PARAM = /^(?:.*token.*|.*secret.*|.*password.*|e|pwd|pass|sig|signature|se|sv|sp|sr|skoid|sktid|key|api[_-]?key|apikey|code|auth.*|session.*|sid|jwt|otp|ticket|credential.*|x-amz-.*|x-goog-.*)$/i;
// A path segment that is a token, not a word: long base64/hex runs.
const TOKEN_SEGMENT = /[A-Za-z0-9_-]{32,}|[A-Fa-f0-9]{24,}/;
const STREET_TYPES = 'Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct|Place|Pl|Crescent|Cres|Highway|Hwy|Terrace|Parkway|Pkwy|Circle|Square|Trail|Row|Mews|Close|Quay';
const STREET_RE = new RegExp(
  `(?:(?:Suite|Unit|Apt|Floor)\\s*#?\\s*\\w{1,6},?\\s+)?(?<![\\w.-])\\d{1,6}(?:-\\d{1,6})?[A-Za-z]?(?:\\s+[\\p{Lu}][\\p{L}'.-]*){1,3}\\s+(?:${STREET_TYPES})\\b\\.?`
  + '(?:,?\\s*(?:Suite|Unit|Apt|Floor)\\s*#?\\s*\\w{1,6})?'
  + '(?:,\\s*[\\p{Lu}][\\p{L}-]+(?:\\s[\\p{Lu}][\\p{L}-]+(?![\\p{L}\\d]))?)?'
  + '(?:,?\\s+[A-Z]{1,2}\\d[A-Z\\d]?\\s?\\d[A-Z]{2}\\b|(?:,?\\s+[A-Z]{2})?(?:,?\\s+[A-Z]\\d[A-Z]\\s?\\d[A-Z]\\d|,?\\s+\\d{5}(?:-\\d{4})?)?)',
  'gu',
);
const IPV6_RE = /(?<![\w:.])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?|::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6}))(?:\/\d{1,3})?(?![\w:])/gi;
const MAC_RE = /(?<![\w:.-])(?:[0-9a-f]{2}([:-])[0-9a-f]{2}(?:\1[0-9a-f]{2}){4}|[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4})(?![\w:.-])/gi;
// "name(at)domain(dot)com", "name [at] domain [dot] ca", "name(at)domain.com".
const OBFUSCATED_EMAIL_RE = /[\w.+-]+\s*[([{]\s*at\s*[)\]}]\s*[\w-]+(?:(?:\s*[([{]\s*dot\s*[)\]}]\s*|\.)[\w-]+)+/gi;
// Employee / badge / passport / licence numbers (the value must hold a digit).
const LABELLED_ID_RE = /\b(employee|staff|badge|passport|driver'?s licen[cs]e|licen[cs]e|student|health card|member)((?:\s+(?:id|number|no\.?|num|#))?)(\s*[:#]?\s*)([A-Z0-9][A-Z0-9-]{3,})\b/gi;
// Meeting ids: the whole "Meeting ID: 912 3456 7890".
const MEETING_ID_RE = /\b(?:(?:zoom|teams|webex|meet)\s+)?(?:meeting\s*(?:id|number|no\.?|#)|(?:zoom|webex)\s*(?:id|#))\s*[:#]?\s*\d{3}[ -]?\d{3,4}[ -]?\d{3,5}\b/gi;
// "0044 20 7946 0958", "001 604 555 0199": the 00 prefix and the whole number.
const INTL_00_RE = /(?<![\w.+-])00\d{1,3}[ .-]?(?:\(\d{1,4}\)[ .-]?)?\d{1,4}(?:[ .-]?\d{2,4}){2,4}(?![\w]|[.-]\d)/g;
// Postcodes (with the town / province / state before them when present).
const CA_PROVINCES = 'BC|AB|SK|MB|ON|QC|NB|NS|PE|NL|YT|NT|NU';
const US_STATES = 'AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC';
const TOWN = "(?:[\\p{Lu}][\\p{L}'-]+(?:\\s[\\p{Lu}][\\p{L}'-]+)?,?\\s+)?";
const CA_POSTAL_RE = new RegExp(`${TOWN}(?:(?:${CA_PROVINCES}),?\\s+)?\\b[ABCEGHJ-NPRSTVXY]\\d[ABCEGHJ-NPRSTV-Z][ -]?\\d[ABCEGHJ-NPRSTV-Z]\\d\\b`, 'gu');
const US_ZIP_RE = new RegExp(`${TOWN}\\b(?:${US_STATES}),?\\s+\\d{5}(?:-\\d{4})?\\b`, 'gu');
const UK_POSTCODE = '[A-Z]{1,2}\\d[A-Z\\d]?\\s?\\d[A-Z]{2}';
const UK_POSTAL_RE = new RegExp(`${TOWN}\\b${UK_POSTCODE}\\b`, 'gu');
// "12 rue de la Paix, 75002 Paris" (French streets, best effort).
const FR_STREET_RE = /\b\d{1,4}(?:\s?(?:bis|ter))?,?\s+(?:rue|avenue|av\.|boulevard|bd|place|chemin|all[ée]e|quai|impasse|route|cours)\s+(?:de\s+la\s+|de\s+l'|du\s+|des\s+|de\s+|d')?[\p{L}'-]+(?:\s+[\p{L}'-]+){0,3}?(?:,?\s+\d{5}\s+[\p{Lu}][\p{L}-]+)?/giu;
// Government ids: US SSN "123-45-6789", Canadian SIN "123 456 789" / "123-456-789".
const GOV_ID_RE = /(?<![\w.-])(?:\d{3}-\d{2}-\d{4}|\d{3}([ -])\d{3}\1\d{3})(?![\w]|[ .-]\d)/g;
// Card numbers: 4-4-4-4(-3), Amex 4-6-5, or 13-19 bare digits — all of it.
const CARD_RE = /(?<![\w.-])(?:\d{4}([ -])\d{4}\1\d{4}\1\d{1,4}(?:\1\d{1,3})?|\d{4}([ -])\d{6}\2\d{5}|\d{13,19})(?![\w]|[.-]\d)/g;
// "jdoe@corp" (an address without a TLD) and Windows sign-ins "BGC\jdoe" / "BGC\\jdoe".
const BARE_ACCOUNT_RE = /(?<![\w.@-])[A-Za-z0-9._%+-]+@[A-Za-z][\w-]*(?![\w.@-])/g;
const WINDOWS_ACCOUNT_RE = /(?<![\w\\:/.$])(?!HKLM|HKCU|HKEY|HKCR|HKU\b)[A-Z][A-Z0-9_-]{1,14}\\{1,2}[A-Za-z][\w.-]{1,30}(?![\w\\])/g;
// Honorific + surname: "Mr. Tanaka", "Dr Kowalczyk", "Ms Lee".
const HONORIFIC_RE = /\b(?:Mr|Mrs|Ms|Miss|Mx|Dr|Prof|Sir|Madam)\.?[ \t]+[\p{Lu}][\p{L}'-]+(?:[ \t]+[\p{Lu}][\p{L}'-]+)?/gu;
// "J. Smith" / "J.Smith": an initial and a capitalised surname (not "Option A. Click").
const INITIAL_SURNAME_RE = /(?<![\p{L}\p{N}.])(\p{Lu})\.[ \t]?(\p{Lu}[\p{Ll}'-]+)/gu;
const NOT_INITIAL_CONTEXT = /\b(?:option|section|step|part|appendix|figure|table|plan|grade|class|type|level|phase|tier|group|vitamin|model|room|block|row|column)\s*$/i;
// Name parts that are everyday words: replaced only where the text capitalises them.
const COMMON_WORD_NAMES = new Set(['will', 'mark', 'bill', 'grant', 'may', 'rose', 'frank', 'jack', 'ray', 'hope', 'art', 'chase', 'drew', 'dean',
  'sky', 'summer', 'guy', 'max', 'miles', 'joy', 'faith', 'june', 'april', 'august', 'rich', 'amber', 'ruby', 'crystal', 'holly', 'iris', 'olive',
  'pearl', 'violet', 'sandy', 'rusty', 'dawn', 'gene', 'glen', 'wade', 'reed', 'dale', 'cliff', 'penny', 'lane', 'hunter', 'carol', 'don', 'pat',
  'sue', 'rob', 'bob', 'brown', 'white', 'black', 'green', 'young', 'long', 'short', 'little', 'king', 'hill', 'wood', 'bird', 'fox', 'stone',
  'rock', 'field', 'marsh', 'banks', 'price', 'cook', 'baker', 'turner', 'walker', 'hall', 'ward', 'page', 'love', 'day', 'may', 'north', 'west',
  'south', 'east', 'bell', 'bush', 'rice', 'moss', 'nash', 'best', 'close', 'open', 'sharp', 'strong', 'swift', 'wise', 'good', 'hope', 'case', 'chance']);
export const ID_MARK = '[ID removed]';
export const MAC_MARK = '[MAC removed]';
export const MEETING_MARK = '[meeting id removed]';
export const CARD_MARK = '[card removed]';
export const ACCOUNT_MARK = '[account removed]';
export const EMAIL_MARK = '[e-mail removed]';
export const PHONE_MARK = '[phone removed]';
export const IP_MARK = '[IP removed]';
export const ADDRESS_MARK = '[address removed]';
export const LINK_MARK = '[link removed]';
export const SECRET_MARK = '[removed]';
export const TICKET_MARK = 'a previous ticket';
// "ticket 242611" / "ticket #242611" / "ticket no. 242611" / "ticket number 242611".
const TICKET_WORD_RE = /\bticket(?:\s+(?:number|num|no\.?|id))?\s*#?\s*\d{3,12}\b/gi;
const TICKET_REF_RE = /\bTP-\d{1,7}\b|(?<![\w&])#\d{4,12}\b|\b(?:INC|REQ|RITM|CHG|PRB|SR|SCTASK|TASK|CS|SD)[ -]?\d{4,12}\b/g;
const GREETING_WORDS = 'hi|hello|hey|dear|good morning|good afternoon|good evening|morning|afternoon|thanks|thank you|many thanks|cheers|regards|best regards|kind regards|warm regards|best|sincerely|respectfully|thx';
const SIGNOFF_WORDS = 'thanks|thank you|many thanks|thanks again|cheers|regards|best regards|kind regards|warm regards|best wishes|all the best|best|sincerely|respectfully|thx|ty';
const NAME_WORD = "[\\p{Lu}][\\p{L}'-]+";
// Case-insensitive greeting word, but the NAME must start with a capital (no
// 'i' flag: with it \p{Lu} would match any letter and "Hello world." loses a word).
const caseAlt = (words) => words.split('|').map((w) => `[${w[0].toUpperCase()}${w[0]}]${w.slice(1)}`).join('|');
const GREETING_NAME_RE = new RegExp(`\\b(${caseAlt(GREETING_WORDS)})([ ,]+)(${NAME_WORD}(?:[ ]${NAME_WORD})?)(?=\\s*[,.!:\\n]|\\s*$)`, 'gmu');
// "Thanks,\nJohn Smith" — a sign-off line, then a line that is only a name.
const SIGNOFF_NAME_RE = new RegExp(`^([ \\t]*(?:${caseAlt(SIGNOFF_WORDS)})[ \\t]*[,.!]?[ \\t]*)((?:\\r?\\n)+)[ \\t]*(${NAME_WORD}(?:[ \\t]+(?:${NAME_WORD}|\\p{Lu}\\.)){0,3})[ \\t]*$`, 'gmu');
// Common words that look like names after a greeting ("Hi team", "Thanks again").
const NOT_A_NAME = new Set(['team', 'all', 'everyone', 'again', 'there', 'folks', 'guys', 'so', 'much', 'for', 'you', 'in', 'advance', 'both', 'it', 'the', 'support', 'helpdesk', 'service', 'desk', 'ticket', 'pulse', 'auto-help']);
// First words of an instruction line, never a name ("Thanks!\nOpen Settings").
const NOT_A_NAME_LINE = new Set(['open', 'click', 'select', 'go', 'run', 'restart', 'reboot', 'sign', 'log', 'press', 'choose', 'type', 'enter',
  'install', 'uninstall', 'update', 'check', 'try', 'please', 'note', 'step', 'then', 'next', 'if', 'when', 'your', 'my', 'our', 'this',
  'that', 'we', 'i', 'let', 'see', 'use', 'close', 'reset', 'start', 'settings', 'windows', 'microsoft', 'office', 'outlook', 'teams']);

/**
 * Common first names, for names nobody passed in. Deliberately leaves out
 * names that are everyday English words (Will, Mark, Bill, Grant, May, Rose,
 * Frank, Jack, Ray, Hope, Art, Chase, Drew, Dean, Sky, Summer, Guy, Max, Miles…).
 */
const FIRST_NAMES = new Set(`
aaron abdul adam adrian ahmad ahmed aidan alan alana albert alex alexa alexander alexandra alexey alexis ali alice alicia
alison allison alyssa amanda amir amit amy ana andre andrea andrew andy angela angelica anita ann anna anne annie anthony anton
antonio arash arjun arthur ashley aurora austin ava barbara behnam ben benjamin beth betty bianca brad bradley brandon brenda
brendan brian brianna bruce bryan caitlin caleb cameron camila carla carlos carmen caroline carrie casey catherine chad charles
charlie charlotte chelsea cheryl chris christian christina christine christopher cindy claire clara claudia colin connor craig
cristina cynthia dan daniel daniela danielle darren david debbie deborah denise derek diana diane diego dmitri dominic donna
dylan edward elena eli elias elijah elizabeth ella ellen emily emma eric erica erin ethan eva evan farhad fatima felix fernando
fiona gabriel gabriela gaby gary gavin george gerald gina gordon grace greg gregory hamid hannah harry hassan heather helen
henry hossein ian isaac isabel isabella ivan jacob james jamie jane janet jared jason javier jeff jeffrey jennifer jenny jeremy
jerry jesse jessica jill jim jimmy joan joanna joel john johnny jon jonathan jordan jorge jose joseph josh joshua juan julia
julian julie justin karen karim kate katherine kathryn katie kayla keith kelly ken kenneth kevin kim kimberly kyle laura lauren
leah lee leila leo leon liam linda lindsay lisa liz logan lorenzo louis lucas lucy luis luke lynn maddie madison mahdi majid
manuel marc marco marcus margaret maria mariam marie marina mario marissa martin mary mason matt matthew maya megan mehdi
melanie melissa michael michelle miguel mike mitchell mohammad mohammed mohsen monica morgan nadia nancy naomi natalie nathan
neil nicholas nick nicole nima noah nora oliver olivia omar oscar owen pablo pamela parisa patricia patrick paul paula pedro
peter philip phillip priya rachel rafael rahul raj rajesh ramin rebecca reza ricardo richard rick robert roberto robin ryan
sabrina sahar saeed samantha samuel sandra sara sarah scott sean sebastian sergei sergio shannon sharon shawn sheila shirin
simon sofia sophia sophie stacy stephanie stephen steve steven stuart susan tanya tara taylor teresa thomas tiffany tim timothy
tina todd tom tony tracy travis tyler valerie vanessa vahid victor victoria vincent wei wendy william xavier yasmin yusuf zachary
zahra zoe
`.split(/\s+/).filter(Boolean));
const FIRST_NAME_ALT = [...FIRST_NAMES].join('|');
// Common first names that are also everyday words, places or products: never replaced on their own.
const LONE_NAME_EXCLUDE = new Set(['grace', 'nick', 'robin', 'lee', 'kim', 'austin', 'jordan', 'victoria', 'charlotte', 'chelsea', 'madison',
  'aurora', 'alexa', 'logan', 'mason', 'taylor', 'morgan', 'casey', 'carmen', 'lynn', 'sandra', 'sophia', 'ava', 'ana', 'eva', 'ella', 'eli',
  'angela', 'rick', 'tim', 'ken', 'dan', 'andy', 'ben', 'jim', 'jimmy', 'tom', 'tony', 'rachel', 'rebecca', 'jill', 'amy', 'beth', 'claire',
  'christian', 'patrick', 'julian', 'lucas', 'simon', 'stuart', 'tracy', 'wendy', 'jane', 'joan', 'marc', 'mario', 'owen', 'shawn', 'darren',
  'dylan', 'kyle', 'ivan', 'oscar', 'leo', 'leon', 'lucy', 'max', 'nora', 'paula', 'peter', 'philip', 'sharon', 'arthur', 'albert', 'henry',
  'george', 'harry', 'louis', 'martin', 'maria', 'marie', 'mary', 'paul', 'thomas', 'william', 'vincent', 'xavier', 'zoe']);
const LONE_NAME_ALT = [...FIRST_NAMES].filter((n) => !LONE_NAME_EXCLUDE.has(n)).join('|');
// A capitalised common first name on its own ("Mehdi confirmed", "Thanks Priya").
const LONE_NAME_RE = new RegExp(`(?<![\\p{L}\\p{N}@.\\\\-])(${LONE_NAME_ALT})(?![\\p{L}\\p{N}@\\\\-])`, 'giu');
// A known first name + 1-2 surname words (case checked in the callback).
const FIRST_LAST_RE = new RegExp(`(?<![\\p{L}\\p{N}@.])(${FIRST_NAME_ALT})((?:[ \\t]+[\\p{L}][\\p{L}'-]+){1,2})(?![\\p{L}\\p{N}@])`, 'giu');
// A subject / line segment that is only a name: "NIck stone - EUROPE move".
const NAME_SEGMENT_RE = new RegExp(`^(?:${FIRST_NAME_ALT})(?:[ \\t]+[\\p{L}][\\p{L}'.-]*){0,2}$`, 'iu');
const SEGMENT_SPLIT_RE = /([ \t]+[-–—|:][ \t]+)/;

const isCap = (s) => Boolean(s) && s[0] !== s[0].toLowerCase() && s[0] === s[0].toUpperCase();

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Name parts worth replacing: the full name first, then parts of 3+ letters. */
export function nameVariants(name) {
  const full = String(name || '').replace(/\s+/g, ' ').trim();
  if (!full || full.includes('@')) return [];
  const parts = full.split(' ').map((p) => p.replace(/[^\p{L}'-]/gu, '')).filter((p) => p.length >= 3);
  return [...new Set([full, ...parts])].sort((a, b) => b.length - a.length);
}

/** One URL: a token-looking path goes entirely; a sensitive query / fragment is cut off. */
function scrubUrl(url) {
  const trail = url.match(/[.,;:!?]+$/)?.[0] || '';
  const raw = trail ? url.slice(0, -trail.length) : url;
  let u;
  try { u = new URL(raw); } catch { return url; }
  if (u.username || u.password) return LINK_MARK + trail;
  // SharePoint / OneDrive share links: /:x:/g/… and /:x:/s/… carry the share token in the path.
  if (/^\/:[a-z]{1,2}:\/[gs]\//i.test(u.pathname)) return LINK_MARK + trail;
  if (u.pathname.split('/').some((seg) => TOKEN_SEGMENT.test(decodeURIComponent(seg)))) return LINK_MARK + trail;
  const params = [...u.searchParams.keys()];
  const hashParams = u.hash.includes('=') ? [...new URLSearchParams(u.hash.slice(1)).keys()] : [];
  const sensitive = params.some((k) => SENSITIVE_PARAM.test(k)) || hashParams.some((k) => SENSITIVE_PARAM.test(k))
    || [...u.searchParams.values()].some((v) => TOKEN_SEGMENT.test(v) || JWT_RE.test(v));
  JWT_RE.lastIndex = 0;
  if (!sensitive) return url;
  return `${u.origin}${u.pathname}${trail}`;
}

/** Drop a line segment that is only a name ("Nick Stone - Europe move" -> "Europe move"). */
function dropNameSegments(line) {
  const parts = line.split(SEGMENT_SPLIT_RE);
  if (parts.length < 3) return line;
  const isName = (seg) => NAME_SEGMENT_RE.test(seg.trim()) && isCap(seg.trim());
  let out = parts;
  if (isName(out[0])) out = out.slice(2);
  if (out.length >= 3 && isName(out[out.length - 1])) out = out.slice(0, -2);
  return out.join('');
}

/**
 * @param {string} text
 * @param {object} [options]
 * @param {Array<{name?: string, email?: string, role?: 'requester'|'agent'|'person'}>} [options.people]
 * @param {number[]} [options.keepTicketIds] internal ticket ids a reviewer note may keep ("ticket 31705")
 * @returns {string}
 */
export function scrubPii(text, { people = [], keepTicketIds = [] } = {}) {
  const keep = new Set((keepTicketIds || []).map(String));
  const ticketRef = (m) => (keep.size && keep.has((m.match(/\d+/g) || []).pop()) ? m : TICKET_MARK);
  let out = String(text ?? '');
  if (!out) return '';
  // Secrets and links first, while URLs are still whole.
  out = out.replace(URL_RE, scrubUrl).replace(JWT_RE, SECRET_MARK)
    .replace(API_TOKEN_RE, SECRET_MARK)
    .replace(BEARER_RE, (m, key, sep) => `${key}${sep}${SECRET_MARK}`)
    .replace(AWS_SECRET_RE, (m, key, sep) => `${key}${sep}${SECRET_MARK}`)
    .replace(PASSPHRASE_RE, (m, key, sep) => `${key}${sep}${SECRET_MARK}`)
    .replace(SECRET_PAIR_RE, (m, key, sep, value) => {
      if (value === SECRET_MARK) return m;
      const word = value.toLowerCase().replace(/[^a-z]/g, '');
      if (/^\s+\w/.test(sep) && NOT_A_SECRET_WORD.has(word) && !/\d/.test(value)) return m;
      return `${key}${sep}${SECRET_MARK}`;
    })
    .replace(LONG_TOKEN_RE, (m) => (looksLikeToken(m) ? SECRET_MARK : m))
    .replace(SECRET_BARE_RE, (m, key, sep, value) => (value !== SECRET_MARK && LOOKS_SECRET.test(value) ? `${key}${sep}${SECRET_MARK}` : m))
    .replace(PIN_RE, (m, key, sep) => `${key}${sep}${SECRET_MARK}`);
  // Sign-in names before e-mail rules ("jdoe@corp" has no TLD; "BGC\jdoe").
  out = out.replace(OBFUSCATED_EMAIL_RE, EMAIL_MARK).replace(EMAIL_RE, EMAIL_MARK).replace(BARE_ACCOUNT_RE, ACCOUNT_MARK).replace(WINDOWS_ACCOUNT_RE, ACCOUNT_MARK);
  // Greetings / sign-offs while the name is still there to recognise.
  out = out.replace(SIGNOFF_NAME_RE, (m, signoff, _nl, who) => {
    const first = who.split(/[ \t]/)[0].toLowerCase();
    return NOT_A_NAME.has(first) || NOT_A_NAME_LINE.has(first) ? m : signoff.trimEnd();
  });
  out = out.replace(GREETING_NAME_RE, (m, word, _sep, who) => (NOT_A_NAME.has(who.split(' ')[0].toLowerCase()) ? m : word));
  for (const person of people || []) {
    const label = person?.role === 'agent' ? 'the agent' : person?.role === 'person' ? 'the person' : 'the requester';
    const email = String(person?.email || '').trim();
    if (email) out = out.replace(new RegExp(escapeRe(email), 'gi'), EMAIL_MARK);
    const full = String(person?.name || '').replace(/\s+/g, ' ').trim();
    for (const variant of nameVariants(person?.name)) {
      // The full name and ordinary name parts match in any case ("susan xu",
      // "XU"); a part that is an everyday word only where the text
      // capitalises it: "Will" / "WILL" yes, "I will mark this" no.
      const common = variant.toLowerCase().split(' ').some((w) => COMMON_WORD_NAMES.has(w));
      const anyCase = !common && (variant.includes(' ') || variant.length >= 3);
      out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(variant)}(?![\\p{L}\\p{N}])`, 'giu'), (m) => (anyCase || isCap(m) ? label : m));
    }
    // Two-letter surnames ("Xu", "Ng", "Li"): capitalised or all caps only.
    for (const part of full.split(' ').slice(1).map((x) => x.replace(/[^\p{L}]/gu, '')).filter((x) => x.length === 2)) {
      out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(part)}(?![\\p{L}\\p{N}])`, 'giu'), (m) => (isCap(m) ? label : m));
    }
  }
  // Names nobody passed in (best effort).
  out = out.split('\n').map(dropNameSegments).join('\n');
  out = out.replace(HONORIFIC_RE, 'the person');
  out = out.replace(INITIAL_SURNAME_RE, (m, _i, surname, offset, whole) => (
    NOT_INITIAL_CONTEXT.test(whole.slice(0, offset)) || NOT_A_NAME_LINE.has(surname.toLowerCase()) || NOT_A_NAME.has(surname.toLowerCase()) ? m : 'the person'));
  out = out.replace(FIRST_LAST_RE, (m, first, rest) => {
    if (!isCap(first)) return m;
    const words = rest.trim().split(/[ \t]+/);
    if (!isCap(words[0]) || NOT_A_NAME.has(words[0].toLowerCase())) return m;
    // "Priya Shah Ramos" -> both capitalised surname words go; a lowercase second word stays.
    const keep = words.length > 1 && !isCap(words[1]) ? ` ${words[1]}` : '';
    const surname = keep || words.length === 1 ? words[0] : words[1];
    return `the person${/'s$/i.test(surname) ? '\'s' : ''}${keep}`;
  });
  out = out.replace(LONE_NAME_RE, (m) => (isCap(m) && m.slice(1) === m.slice(1).toLowerCase() ? 'the person' : m));
  out = out
    .replace(EMAIL_RE, EMAIL_MARK)
    .replace(MEETING_ID_RE, MEETING_MARK)
    .replace(LABELLED_ID_RE, (m, key, label, sep, value) => (/\d/.test(value) ? `${key}${label}${sep}${ID_MARK}` : m))
    .replace(FR_STREET_RE, ADDRESS_MARK)
    .replace(STREET_RE, ADDRESS_MARK)
    .replace(UK_POSTAL_RE, ADDRESS_MARK)
    .replace(CA_POSTAL_RE, ADDRESS_MARK)
    .replace(US_ZIP_RE, ADDRESS_MARK)
    .replace(MAC_RE, MAC_MARK)
    .replace(IPV6_RE, (m) => (/\d/.test(m) && m.replace(/[^:]/g, '').length >= 2 ? IP_MARK : m))
    .replace(IPV4_RE, IP_MARK)
    .replace(CARD_RE, CARD_MARK)
    .replace(GOV_ID_RE, ID_MARK)
    .replace(INTL_00_RE, PHONE_MARK)
    .replace(PHONE_RE, PHONE_MARK)
    .replace(CUED_PHONE_RE, (m, cue, sep) => `${cue}${sep}${PHONE_MARK}`)
    .replace(EXTRA_PHONE_RE, PHONE_MARK)
    .replace(LOCAL_PHONE_RE, PHONE_MARK)
    .replace(EXTENSION_RE, PHONE_MARK)
    .replace(TICKET_WORD_RE, ticketRef)
    .replace(TICKET_REF_RE, ticketRef);
  // Collapse what the removals left behind: "the requester the requester",
  // "[phone removed] [phone removed]", empty parentheses, doubled spaces and
  // spaces before punctuation.
  return out
    .replace(/\b(the (?:requester|agent|person))(?:\s+the (?:requester|agent|person))+\b/gi, '$1')
    .replace(/(\[phone removed\])(?:[\s,]+\[phone removed\])+/g, '$1')
    .replace(/(\[address removed\])(?:[\s,]+\[address removed\])+/g, '$1')
    .replace(/\(\s*[,;:]?\s*\)/g, '')
    .replace(/<\s*>/g, '')
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[ \t]+|[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** True when the text still carries an e-mail address, a phone number or an IP (tests / final checks). */
export function containsPii(text) {
  const s = String(text || '');
  const hit = [EMAIL_RE, PHONE_RE, IPV4_RE].some((re) => {
    re.lastIndex = 0;
    const found = re.test(s);
    re.lastIndex = 0;
    return found;
  });
  return hit;
}

export default scrubPii;
