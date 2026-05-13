import { jest } from '@jest/globals';

import {
  freshServiceGroupHasAgent,
  normalizeFreshServiceGroupMemberIds,
  resolveBroadAssignmentGroup,
} from '../src/services/freshServiceGroupGuard.js';

describe('freshServiceGroupGuard', () => {
  test('normalizes FreshService member IDs from members and agent_ids', () => {
    expect(normalizeFreshServiceGroupMemberIds({ members: ['100', 200, 'bad'] })).toEqual([100, 200]);
    expect(normalizeFreshServiceGroupMemberIds({ agent_ids: ['300'] })).toEqual([300]);
    expect(normalizeFreshServiceGroupMemberIds({})).toBeNull();
  });

  test('treats missing membership lists as unknown instead of incompatible', () => {
    expect(freshServiceGroupHasAgent({}, 100)).toBe(true);
    expect(freshServiceGroupHasAgent({ members: [101] }, 100)).toBe(false);
    expect(freshServiceGroupHasAgent({ members: ['100'] }, 100)).toBe(true);
  });

  test('resolves Everyone IT only when the target agent belongs to it', async () => {
    const client = {
      listGroups: jest.fn().mockResolvedValue([
        { id: 1000009787, name: 'Advanced Troubleshooting team', members: [1] },
        { id: 1000205455, name: 'Everyone IT', members: ['1000765712'] },
      ]),
    };

    const result = await resolveBroadAssignmentGroup(client, { workspaceId: '2' }, 1000765712, 1000009787);

    expect(result).toEqual({
      ok: true,
      group: { id: 1000205455, name: 'Everyone IT' },
    });
    expect(client.listGroups).toHaveBeenCalledWith({ workspace_id: 2 });
  });

  test('does not resolve Everyone IT when the target agent is not a member', async () => {
    const client = {
      listGroups: jest.fn().mockResolvedValue([
        { id: 1000205455, name: 'Everyone IT', members: [42] },
      ]),
    };

    const result = await resolveBroadAssignmentGroup(client, { workspaceId: '2' }, 1000765712, 1000009787);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('not a member of fallback group');
  });
});
