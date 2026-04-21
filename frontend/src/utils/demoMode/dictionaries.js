// Dictionaries used by the demo mode mapper.
// Kept hand-curated (no faker dependency) so the bundle stays small and
// the same set of fake identities can be relied upon across builds.

export const FIRST_NAMES = [
  'Alex', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Quinn', 'Avery',
  'Sage', 'Reese', 'Drew', 'Hayden', 'Skyler', 'Rowan', 'Emerson', 'Dakota',
  'Parker', 'Finley', 'Harper', 'Sawyer', 'Logan', 'Phoenix', 'Blake', 'Kendall',
  'Marlowe', 'Sutton', 'Wesley', 'Frankie', 'Spencer', 'Adrian', 'Bailey', 'Cameron',
  'Charlie', 'Devon', 'Ellis', 'Gabriel', 'Hayley', 'Iris', 'Jamie', 'Kai',
  'Leslie', 'Micah', 'Noel', 'Oakley', 'Peyton', 'Quincy', 'Remi', 'Shiloh',
  'Tate', 'Umi', 'Vesper', 'Winter', 'Xander', 'Yara', 'Zane', 'Aria',
  'Beau', 'Celeste', 'Dante', 'Eloise', 'Felix', 'Greta', 'Hugo', 'Indigo',
  'Juno', 'Kira', 'Lior', 'Maeve', 'Niko', 'Orla', 'Piper', 'Rhea',
  'Soren', 'Theo', 'Una', 'Vance', 'Wren', 'Xiomara', 'Yuki', 'Zia',
];

export const LAST_NAMES = [
  'Carter', 'Hayes', 'Brooks', 'Reed', 'Morgan', 'Bennett', 'Foster', 'Hughes',
  'Sullivan', 'Owens', 'Walsh', 'Pierce', 'Holloway', 'Sterling', 'Marsh', 'Whitaker',
  'Ainsworth', 'Bishop', 'Caldwell', 'Donovan', 'Ellington', 'Fairfax', 'Gallagher', 'Holt',
  'Ivers', 'Jameson', 'Keane', 'Langston', 'Maddox', 'Norwood', 'Ortega', 'Prescott',
  'Quinto', 'Ravenel', 'Sinclair', 'Thatcher', 'Underwood', 'Vance', 'Whitlock', 'Yardley',
  'Ashford', 'Beaumont', 'Calloway', 'Drummond', 'Easton', 'Forrester', 'Greenwood', 'Halverson',
  'Iverson', 'Jacoby', 'Kingsley', 'Linden', 'Mercer', 'Nash', 'Osmond', 'Paxton',
  'Rourke', 'Stratton', 'Tennyson', 'Upton', 'Vasquez', 'Wakefield', 'Yeats', 'Zimmer',
  'Abrams', 'Boone', 'Cabrera', 'Delgado', 'Espinoza', 'Fontaine', 'Granger', 'Hartwell',
  'Ito', 'Jensen', 'Khoury', 'Lévesque', 'Moreau', 'Nakamura', 'Okafor', 'Petrov',
];

// Locations that are valid keys in the Visuals page OFFICE_LOCATIONS map,
// so the office pin still drops on a real Canadian city when we swap.
export const FAKE_LOCATIONS = [
  'Halifax', 'Winnipeg', 'Saskatoon', 'Regina', 'Quebec City', 'Montreal',
  'Fredericton', 'Moncton', 'Charlottetown', "St. John's", 'Whitehorse',
  'Yellowknife', 'Thunder Bay', 'Hamilton', 'London', 'Kitchener', 'Waterloo',
  'Mississauga', 'Surrey', 'Burnaby', 'Richmond', 'Nanaimo', 'Victoria',
  'Red Deer', 'Lethbridge', 'Prince George',
];

// Used to rebuild scrubbed computer names. e.g. ACME-WS-042, NIMBUS-SRV-007.
export const FAKE_COMPANY_PREFIXES = [
  'ACME', 'NIMBUS', 'ORION', 'AURORA', 'ZENITH', 'HELIX', 'SUMMIT', 'VERTEX',
  'NOVA', 'ATLAS',
];

export const FAKE_DEVICE_KINDS = [
  'WS', 'LAP', 'SRV', 'NB', 'PC', 'WK',
];

// Real BGC-related substrings to look for inside ticket subjects so we can
// scrub them even if they are not in the technician name list. Kept as a
// fixed set of internal tokens that show up in the screenshots and audit logs.
export const KNOWN_INTERNAL_TOKENS = [
  'BGC Engineering', 'BGC ENGINEERING', 'BGC Engr', 'bgcengineering.ca',
  'bgcsaas.com', 'bgcsaas', 'BGC IT', 'BGC',
];

// Real BGC office locations we actively replace inside free-text subjects.
// Lowercased matching is done at runtime; this list is the canonical set.
export const KNOWN_BGC_LOCATIONS = [
  'Vancouver', 'Calgary', 'Edmonton', 'Ottawa', 'Toronto', 'Kamloops',
  'Kelowna', 'Golden', 'Cranbrook', 'Squamish', 'Whistler', 'Penticton',
  'Burnaby', 'Surrey',
];

// Computer-name detection regex. Catches BGC-prefixed device tags like
// BGC-KAM-HV02, BGC-EDM-HV01, BGC-TOR-LIDAR1, BGC-KAM-FILE2.
export const COMPUTER_REGEX =
  /\b(?:BGC|TOR|EDM|KAM|VAN|OTT|CGY|YYC|YVR|YYZ|YOW)(?:-[A-Z0-9]+){1,4}\b/g;

export const EMAIL_REGEX = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export const FAKE_EMAIL_DOMAIN = 'acme.example';
