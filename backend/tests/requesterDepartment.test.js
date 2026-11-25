import { jest } from '@jest/globals';

/**
 * QA 11-24 #1: Department and City apart. requesters.department is
 * FreshService's department (the office city here); entra_department is the
 * job class plus a level. departmentOf / cityOf split them, and the
 * `department_map` app setting can change the table.
 */

const settingsGet = jest.fn();
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: { get: settingsGet } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
  departmentOf, cityOf, stripLevel, mergeDepartmentMap, normalizeDepartment, PROFESSIONAL_LADDER_LABEL,
} = await import('../src/utils/requesterDepartment.js');
const { getDepartmentMap, describeDepartmentMap, resetDepartmentMapCache } = await import('../src/services/departmentMapService.js');

const GEO = PROFESSIONAL_LADDER_LABEL;

describe('stripLevel', () => {
  test.each([
    ['Contracts III', 'Contracts'], ['Senior I', 'Senior'], ['HR V', 'HR'], ['Admin IV', 'Admin'],
    ['Data Management V', 'Data Management'], ['Software VI', 'Software'], ['Level 2', 'Level'],
    ['Student Intern', 'Student Intern'], ['Information Management', 'Information Management'],
    ['Consultant', 'Consultant'], ['  Payroll   I ', 'Payroll'],
  ])('%s → %s', (input, out) => expect(stripLevel(input)).toBe(out));
});

describe('departmentOf — the production Entra values', () => {
  test.each([
    ['Senior I', GEO], ['Junior II', GEO], ['Intermediate I', GEO], ['Principal III', GEO],
    ['Student Intern', GEO], ['Junior Intern', GEO], ['Consultant', GEO],
    ['Software III', 'Software'], ['Accountant I', 'Accounting'], ['Project Accountant III', 'Project Accounting'],
    ['CAD II', 'CAD'], ['Admin IV', 'Admin'], ['HR V', 'HR'], ['GIS III', 'GIS'], ['Technician II', 'Technician'],
    ['Information Technology II', 'IT'], ['Information Management', 'Information Management'],
    ['Contracts III', 'Contracts'], ['Library I', 'Library'], ['HS III', 'Health & Safety'],
    ['Health and Safety Coordinator', 'Health & Safety'], ['Payroll I', 'Payroll'], ['Documents IV', 'Documents'],
    ['Regional Controller', 'Finance'], ['Financial Controller', 'Finance'], ['Finance Manager', 'Finance'],
    ['Payroll Manager', 'Payroll'], ['Project Controls III', 'Project Controls'], ['FE III', 'Field Equipment'],
    ['Marcom II', 'Marketing & Communications'], ['Data Management V', 'Data Management'],
  ])('%s → %s', (entra, dept) => {
    expect(departmentOf({ entraDepartment: entra, department: 'Vancouver' })).toBe(dept);
  });

  test('the FreshService city is never a department', () => {
    for (const city of ['Vancouver', 'Calgary', 'Colorado', 'Kamloops', 'Montreal, QC', 'Non-BGC Email']) {
      expect(departmentOf({ entraDepartment: null, department: city })).toBeNull();
    }
  });

  test('"Vancouver - Software" gives Software when Entra has none, and Entra wins when it has one', () => {
    expect(departmentOf({ entraDepartment: null, department: 'Vancouver - Software' })).toBe('Software');
    expect(departmentOf({ entraDepartment: 'CAD II', department: 'Vancouver - Software' })).toBe('CAD');
  });

  test('a FreshService value that names a department is kept (approval card fixtures)', () => {
    expect(departmentOf({ entraDepartment: null, department: 'Finance' })).toBe('Finance');
  });

  test('nothing anywhere → null', () => {
    expect(departmentOf(null)).toBeNull();
    expect(departmentOf({})).toBeNull();
    expect(departmentOf({ entraDepartment: '  ' })).toBeNull();
  });
});

describe('cityOf', () => {
  test('Entra city, then Entra office, then the FreshService department', () => {
    expect(cityOf({ entraCity: 'Calgary', entraOfficeLocation: 'Vancouver', department: 'Kamloops' })).toBe('Calgary');
    expect(cityOf({ entraCity: null, entraOfficeLocation: 'Vancouver', department: 'Kamloops' })).toBe('Vancouver');
    expect(cityOf({ department: 'Kamloops' })).toBe('Kamloops');
    expect(cityOf({ department: 'Montreal, QC' })).toBe('Montreal, QC');
  });

  test('"Vancouver - Software" is Vancouver; "Non-BGC Email" and department names are not places', () => {
    expect(cityOf({ department: 'Vancouver - Software' })).toBe('Vancouver');
    expect(cityOf({ department: 'Non-BGC Email' })).toBeNull();
    expect(cityOf({ department: 'Finance' })).toBeNull();
    expect(cityOf(null)).toBeNull();
  });
});

describe('the table can be changed', () => {
  test('mergeDepartmentMap: overrides win, "" removes a default, prefix keys work', () => {
    const map = mergeDepartmentMap({ Senior: 'Engineering', CAD: 'Drafting', Consultant: '', 'Lab*': 'Laboratory' });
    expect(normalizeDepartment('Senior II', map)).toBe('Engineering');
    expect(normalizeDepartment('CAD II', map)).toBe('Drafting');
    expect(normalizeDepartment('Consultant', map)).toBe('Consultant');
    expect(normalizeDepartment('Lab Technician II', map)).toBe('Laboratory');
    expect(normalizeDepartment('Junior I', map)).toBe(GEO);
  });

  test('departmentMapService reads app_settings department_map, and bad JSON falls back to the defaults', async () => {
    resetDepartmentMapCache();
    settingsGet.mockResolvedValueOnce(JSON.stringify({ Senior: 'Engineering' }));
    const map = await getDepartmentMap({ fresh: true });
    expect(settingsGet).toHaveBeenCalledWith('department_map');
    expect(departmentOf({ entraDepartment: 'Senior I' }, map)).toBe('Engineering');
    const described = await describeDepartmentMap();
    expect(described).toMatchObject({ settingKey: 'department_map', overrides: { Senior: 'Engineering' } });

    settingsGet.mockResolvedValueOnce('{not json');
    const fallback = await getDepartmentMap({ fresh: true });
    expect(departmentOf({ entraDepartment: 'Senior I' }, fallback)).toBe(GEO);

    settingsGet.mockRejectedValueOnce(new Error('db down'));
    const onError = await getDepartmentMap({ fresh: true });
    expect(departmentOf({ entraDepartment: 'Accountant I' }, onError)).toBe('Accounting');
  });
});
