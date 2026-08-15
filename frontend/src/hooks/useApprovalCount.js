import { useCallback, useEffect, useState } from 'react';
import { ticketsAPI } from '../services/api';
import { useSSE } from './useSSE';
import { useWorkspace } from '../contexts/WorkspaceContext';

/**
 * Live count of approvals pending the current user's decision — drives the
 * Approvals nav badge. Refreshes on mount, on workspace switch, and whenever an
 * approval changes (SSE ticket-change with action='approval').
 */
export function useApprovalCount() {
  const { currentWorkspace, isWorkspaceSelected } = useWorkspace();
  const [count, setCount] = useState(0);

  const refresh = useCallback(async () => {
    try {
      setCount(await ticketsAPI.approvalInboxCount());
    } catch {
      /* silent — no access / not configured */
    }
  }, []);

  useEffect(() => {
    if (isWorkspaceSelected) refresh();
    else setCount(0);
  }, [isWorkspaceSelected, currentWorkspace?.id, refresh]);

  const onTicketChange = useCallback((data) => {
    if (data?.action === 'approval') refresh();
  }, [refresh]);

  // reconnectKey: deterministic stream re-key on workspace switch (realtime
  // plan Phase 1) — the context-subscribed id, not a render-time module read.
  useSSE({ onTicketChange, enabled: Boolean(isWorkspaceSelected), reconnectKey: currentWorkspace?.id });

  return count;
}
