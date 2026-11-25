import { describe, expect, it } from 'vitest';
import * as front from './requesterDepartment';
// The backend helper is a pure module with no imports; this test holds the
// frontend mirror to the same table and the same answers (QA 11-24 #1).
import * as back from '../../../backend/src/utils/requesterDepartment.js';

const ENTRA = [
  'Senior I', 'Junior II', 'Intermediate I', 'Principal III', 'Student Intern', 'Junior Intern', 'Consultant',
  'Software III', 'Accountant I', 'Project Accountant III', 'CAD II', 'Admin IV', 'HR V', 'GIS III', 'Technician II',
  'Information Technology II', 'Information Management', 'Contracts III', 'Library I', 'HS III',
  'Health and Safety Coordinator', 'Payroll I', 'Documents IV', 'Regional Controller', 'Financial Controller',
  'Finance Manager', 'Payroll Manager', 'Project Controls III', 'FE III', 'Marcom II', 'Data Management V', null, '',
];
const FS = ['Vancouver', 'Calgary', 'Colorado', 'Kamloops', 'Montreal, QC', 'Vancouver - Software', 'Non-BGC Email', 'Finance', null];

describe('requesterDepartment — frontend mirror matches the backend', () => {
  it('same default table and ladder label', () => {
    expect(front.DEFAULT_DEPARTMENT_MAP).toEqual(back.DEFAULT_DEPARTMENT_MAP);
    expect(front.PROFESSIONAL_LADDER_LABEL).toBe(back.PROFESSIONAL_LADDER_LABEL);
  });

  it('same department and city for every production value pair', () => {
    for (const entraDepartment of ENTRA) {
      for (const department of FS) {
        for (const entraCity of [null, 'Calgary']) {
          const r = { entraDepartment, department, entraCity, entraOfficeLocation: null };
          expect(front.departmentOf(r, front.DEFAULT_DEPARTMENT_MAP)).toBe(back.departmentOf(r));
          expect(front.cityOf(r, front.DEFAULT_DEPARTMENT_MAP)).toBe(back.cityOf(r));
        }
      }
    }
  });

  it('splits the mixed sidebar string from QA ("Contracts III · Vancouver")', () => {
    const r = { entraDepartment: 'Contracts III', entraOfficeLocation: 'Vancouver', department: 'Vancouver' };
    expect(front.departmentOf(r)).toBe('Contracts');
    expect(front.cityOf(r)).toBe('Vancouver');
  });

  it('ticketRequesterPlace fills the FreshService department from the ticket', () => {
    const place = front.ticketRequesterPlace({ department: 'Kamloops', requester: { name: 'A', department: null } });
    expect(front.cityOf(place)).toBe('Kamloops');
  });

  it('an installed admin table changes the answers', () => {
    front.setDepartmentMap(front.mergeDepartmentMap({ Senior: 'Engineering' }));
    expect(front.departmentOf({ entraDepartment: 'Senior II' })).toBe('Engineering');
    front.resetDepartmentMap();
    expect(front.departmentOf({ entraDepartment: 'Senior II' })).toBe(front.PROFESSIONAL_LADDER_LABEL);
  });
});
