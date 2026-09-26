import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  BookMarked, Eye, Hand, Plus, Send, ShieldCheck,
} from 'lucide-react';
import { knowledgeAPI } from '../../services/api';
import { Switch } from '../ui';
import { timeAgo } from '../tickets/ticketUi';
import PlaybookBuilder from './PlaybookBuilder';
import { EmptyState, Loading } from './knowledgeUi';
import { categoryLabel } from './knowledgeFormat';
import { IconTile, StatusBadge, TabActions } from './builderUi';

export { FALLBACK_NUDGE_TEXT } from './PlaybookBuilder';

const MODE_SHORT = { shadow: 'Shadow', approve: 'Approve', auto: 'Auto' };

/** Knowledge → Playbooks: one card per playbook, switch on the card. */
function PlaybookList({ categories, canManage }) {
  const navigate = useNavigate();
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    knowledgeAPI.listPlaybooks()
      .then((res) => { if (!cancelled) setItems(res?.data || []); })
      .catch((err) => { if (!cancelled) setError(err?.message || 'Could not load playbooks'); });
    return () => { cancelled = true; };
  }, []);

  const toggle = async (pb, enabled) => {
    setBusyId(pb.id);
    setError(null);
    try {
      const res = await knowledgeAPI.updatePlaybook(pb.id, { enabled });
      setItems((list) => list.map((x) => (x.id === pb.id ? { ...x, ...res.data } : x)));
    } catch (err) {
      setError(err?.message || 'Could not switch the playbook');
    } finally {
      setBusyId(null);
    }
  };

  if (!items && !error) return <Loading label="Loading playbooks…" />;

  return (
    <div className="space-y-4">
      {canManage && (
        <TabActions>
          <button
            type="button"
            onClick={() => navigate('/knowledge/playbooks/new')}
            className="tp-focus-ring inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-sm font-semibold text-primary-foreground shadow-sm hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" aria-hidden="true" /> New playbook
          </button>
        </TabActions>
      )}
      <p className="text-[13px] text-muted-foreground">
        A playbook answers one kind of request, from your knowledge. When two fit a ticket, the higher priority runs.
      </p>
      {error && <p className="text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>}
      {items && items.length === 0 ? (
        <div className="tp-card">
          <EmptyState icon={BookMarked} title="No playbooks yet">
            Start with the requests your team answers the same way every time — software installs, password resets, travel roaming.
          </EmptyState>
        </div>
      ) : items && (
        <ul className="grid gap-3 lg:grid-cols-2" data-testid="playbooks-list">
          {items.map((pb) => (
            <li key={pb.id} className="tp-card flex items-start gap-3.5 p-4 transition-shadow hover:shadow-soft">
              <IconTile icon={BookMarked} size="md" tone={pb.enabled ? 'primary' : 'muted'} />
              <Link to={`/knowledge/playbooks/${pb.id}`} className="tp-focus-ring min-w-0 flex-1 rounded">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 truncate text-[15px] font-semibold text-foreground">{pb.name}</span>
                  <StatusBadge tone={pb.enabled ? 'success' : 'muted'}>{pb.enabled ? 'Active' : 'Off'}</StatusBadge>
                </span>
                <span className="mt-0.5 block truncate text-[13px] text-muted-foreground">{categoryLabel(categories, pb.categoryId, pb.subcategoryIds)}</span>
                <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    {pb.mode === 'approve' || pb.mode === 'auto' ? <Send className="h-3.5 w-3.5" aria-hidden="true" /> : <Eye className="h-3.5 w-3.5" aria-hidden="true" />}
                    {MODE_SHORT[pb.mode] || 'Shadow'}
                  </span>
                  {pb.sensitive && <span className="inline-flex items-center gap-1"><ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />sensitive</span>}
                  {(pb.stayQuietWhen || []).length > 0 && (
                    <span className="inline-flex items-center gap-1"><Hand className="h-3.5 w-3.5" aria-hidden="true" />{pb.stayQuietWhen.length} stay-quiet rule{pb.stayQuietWhen.length === 1 ? '' : 's'}</span>
                  )}
                  <span>priority {pb.priority}</span>
                  <span>{pb.lastRunAt ? `last run ${timeAgo(pb.lastRunAt)} · ${pb.runCount} run${pb.runCount === 1 ? '' : 's'}` : 'never run'}</span>
                </span>
              </Link>
              {canManage && (
                <Switch
                  checked={pb.enabled}
                  disabled={busyId === pb.id || (!pb.enabled && !pb.categoryId)}
                  onCheckedChange={(v) => toggle(pb, v)}
                  aria-label={`${pb.enabled ? 'Switch off' : 'Switch on'} ${pb.name}`}
                  title={!pb.categoryId ? 'Pick a category first' : undefined}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function PlaybooksPanel({ itemId, categories = [], canManage = false, tools = [], defaults = null }) {
  if (itemId) return <PlaybookBuilder playbookId={itemId} categories={categories} canManage={canManage} tools={tools} defaults={defaults} />;
  return <PlaybookList categories={categories} canManage={canManage} />;
}
