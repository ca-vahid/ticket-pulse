import { jest } from '@jest/globals';

/**
 * Auto-help P1 audit guards that are pure or need only a thin mock:
 * readiness evidence (current version only, backtests never gate), the
 * resolution kind an Auto-help close writes, the per-ticket proposal lock,
 * and the role gates on the Auto-help write paths.
 */
const getAccessRoleMock = jest.fn();
jest.unstable_mockModule('../src/services/workspaceRepository.js', () => ({
  default: { getAccessRole: getAccessRoleMock, hasActiveTechnician: jest.fn() },
  mergeWorkspaceLists: () => [],
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { readinessEvidence, evaluateReadiness } = await import('../src/services/autoHelpOutcomes.js');
const { resolvedByKindFromActor } = await import('../src/services/resolutionReasonService.js');
const { lockTicketProposals, PROPOSAL_LOCK_NAMESPACE } = await import('../src/services/ticketProposedReplyService.js');
const { blockReadonlyWrites } = await import('../src/middleware/auth.js');

describe('readiness evidence', () => {
  const at = (i) => new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString();
  const rowsOf = (n, extra) => Array.from({ length: n }, (_, i) => ({ reviewVerdict: 'good', reviewedAt: at(i), ...extra }));

  test('30 good reviews of an OLD version do not count once the playbook changed', () => {
    const ev = readinessEvidence(rowsOf(30, { playbookVersion: 1, trigger: 'categorized' }), { currentVersion: 2 });
    expect(ev.reviews).toHaveLength(0);
    const r = evaluateReadiness({ ...ev, sensitive: false });
    expect(r.criteria.find((c) => c.key === 'reviewed')).toMatchObject({ value: 0, met: false });
  });

  test('backtest and test runs never gate; backtests are a separate, non-gating line', () => {
    const ev = readinessEvidence([
      ...rowsOf(30, { playbookVersion: 2, trigger: 'backtest' }),
      ...rowsOf(5, { playbookVersion: 2, trigger: 'test' }),
      ...rowsOf(3, { playbookVersion: 2, trigger: 'categorized' }),
    ], { currentVersion: 2 });
    expect(ev.reviews).toHaveLength(3);
    const r = evaluateReadiness({ ...ev, sensitive: false });
    expect(r.met).toBe(false);
    expect(r.backtest).toEqual({ reviewed: 30, good: 30, goodPct: 100, gating: false });
  });

  test('approve-mode sends count only for the current version and never from backtests', () => {
    const ev = readinessEvidence([
      { decision: 'agent_sent', playbookVersion: 2, trigger: 'categorized' },
      { decision: 'agent_edited_sent', playbookVersion: 2, trigger: 'categorized', outcome: 'reopened' },
      { decision: 'agent_sent', playbookVersion: 1, trigger: 'categorized' },
      { decision: 'agent_sent', playbookVersion: 2, trigger: 'backtest' },
    ], { currentVersion: 2 });
    expect(ev.approve).toEqual({ sends: 2, unchanged: 1, reopened: 1 });
  });
});

describe('resolution kind', () => {
  test('an Auto-help close names itself in the same write; other automation stays "automation"', () => {
    expect(resolvedByKindFromActor({ name: 'Ticket Pulse (Auto-help)', role: 'automation', resolvedByKind: 'auto_help' })).toBe('auto_help');
    expect(resolvedByKindFromActor({ name: 'Ticket Pulse (Auto-help)', role: 'automation' })).toBe('automation');
    expect(resolvedByKindFromActor({ role: 'automation', resolvedByKind: 'anything_else' })).toBe('automation');
    expect(resolvedByKindFromActor({ name: 'Dana', role: 'user' })).toBe('human');
  });
});

describe('proposal lock', () => {
  test('takes a transaction-scoped advisory lock keyed by ticket before check-and-create', async () => {
    const tx = { $queryRaw: jest.fn(async () => [{ locked: 1 }]) };
    expect(await lockTicketProposals(tx, 55)).toBe(true);
    const [strings, ns, ticketId] = tx.$queryRaw.mock.calls[0];
    expect(strings.join('?')).toMatch(/pg_advisory_xact_lock\(\?::int, \?::int\)/);
    expect([ns, ticketId]).toEqual([PROPOSAL_LOCK_NAMESPACE, 55]);
  });

  test('a client without raw SQL (unit mocks) is a no-op, never an error', async () => {
    expect(await lockTicketProposals({}, 55)).toBe(false);
  });
});

describe('role gates on the Auto-help write paths', () => {
  const run = (req) => new Promise((resolve) => blockReadonlyWrites(req, {}, resolve));
  const req = (user, path, method = 'POST') => ({ method, path, headers: { 'x-workspace-id': '1' }, query: {}, session: { user } });

  test('readonly: sending or dismissing an Auto-help suggestion is refused (403 read_only_role)', async () => {
    getAccessRoleMock.mockResolvedValue('readonly');
    for (const path of ['/tickets/55/proposed-replies/77/send', '/tickets/55/proposed-replies/77/dismiss', '/knowledge/playbooks/3']) {
      const err = await run(req({ email: 'ro@example.com', role: 'user' }, path, path.endsWith('/3') ? 'DELETE' : 'POST'));
      expect(err).toMatchObject({ statusCode: 403, code: 'read_only_role' });
    }
  });

  test('agents (standard role) may send; reading readiness is a GET for anyone', async () => {
    getAccessRoleMock.mockResolvedValue('agent');
    expect(await run(req({ email: 'agent@example.com', role: 'user' }, '/tickets/55/proposed-replies/77/send'))).toBeUndefined();
    getAccessRoleMock.mockResolvedValue('readonly');
    expect(await run(req({ email: 'ro@example.com', role: 'user' }, '/knowledge/playbooks/3/readiness', 'GET'))).toBeUndefined();
  });
});
