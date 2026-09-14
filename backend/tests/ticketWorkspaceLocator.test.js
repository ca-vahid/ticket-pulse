import { describe, expect, test, jest } from '@jest/globals';
import { locateTicketWorkspaceForUser } from '../src/services/ticketWorkspaceLocator.js';

// 14 Sep 2026: a canonical ticket link opened while the session sat on another
// workspace answered "not found in this workspace"; the page can now learn
// where the ticket lives and switch — but only to a workspace the user may see.
describe('locateTicketWorkspaceForUser', () => {
  const it = { workspaceId: 1, workspace: { id: 1, name: 'IT', slug: 'it', isActive: true } };
  const deps = (row, accessible) => ({
    prisma: { ticket: { findUnique: jest.fn().mockResolvedValue(row) } },
    workspaceRepository: { getAccessibleWorkspaces: jest.fn().mockResolvedValue(accessible) },
  });

  test('a ticket in another workspace the user can access is located', async () => {
    const d = deps(it, [{ id: 1 }, { id: 2 }]);
    expect(await locateTicketWorkspaceForUser({ ticketId: 44797, currentWorkspaceId: 2, userEmail: 'V@BGC.ca' }, d))
      .toEqual({ id: 1, name: 'IT', slug: 'it' });
    expect(d.workspaceRepository.getAccessibleWorkspaces).toHaveBeenCalledWith('v@bgc.ca');
  });

  test('no access to that workspace → null (the plain not-found stands)', async () => {
    expect(await locateTicketWorkspaceForUser({ ticketId: 44797, currentWorkspaceId: 2, userEmail: 'x@bgc.ca' }, deps(it, [{ id: 2 }]))).toBeNull();
  });

  test('same workspace, unknown ticket, inactive workspace or no user → null', async () => {
    expect(await locateTicketWorkspaceForUser({ ticketId: 44797, currentWorkspaceId: 1, userEmail: 'v@bgc.ca' }, deps(it, [{ id: 1 }]))).toBeNull();
    expect(await locateTicketWorkspaceForUser({ ticketId: 1, currentWorkspaceId: 2, userEmail: 'v@bgc.ca' }, deps(null, [{ id: 1 }]))).toBeNull();
    expect(await locateTicketWorkspaceForUser({ ticketId: 1, currentWorkspaceId: 2, userEmail: 'v@bgc.ca' }, deps({ ...it, workspace: { ...it.workspace, isActive: false } }, [{ id: 1 }]))).toBeNull();
    expect(await locateTicketWorkspaceForUser({ ticketId: 1, currentWorkspaceId: 2, userEmail: null }, deps(it, [{ id: 1 }]))).toBeNull();
  });
});
