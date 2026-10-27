import { repairCp437Mojibake } from '../src/utils/mojibake.js';

describe('repairCp437Mojibake', () => {
  test('turns UTF-8 read as code page 437 back into the name', () => {
    expect(repairCp437Mojibake("Rita-H├⌐l├¿ne D'Requester")).toBe("Rita-Hélène D'Requester");
    expect(repairCp437Mojibake('Jos├⌐ N├║├▒ez')).toBe('José Núñez');
  });

  test('leaves clean and unrelated text alone', () => {
    expect(repairCp437Mojibake('Rita Requester')).toBe('Rita Requester');
    expect(repairCp437Mojibake('Hélène')).toBe('Hélène');
    expect(repairCp437Mojibake('Build ├── tree')).toBe('Build ├── tree');
    expect(repairCp437Mojibake('Café ├⌐')).toBe('Café ├⌐');
    expect(repairCp437Mojibake(null)).toBe(null);
  });
});
