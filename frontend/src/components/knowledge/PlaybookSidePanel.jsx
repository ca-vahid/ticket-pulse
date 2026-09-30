import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity, AlertTriangle, Eye, FlaskConical, History, MailOpen,
} from 'lucide-react';
import { knowledgeAPI } from '../../services/api';
import { timeAgo } from '../tickets/ticketUi';
import PlaybookTestBox from './PlaybookTestBox';
import PlaybookBacktestBox from './PlaybookBacktestBox';
import { ReadinessList } from './PlaybookMetrics';
import { DraftPreview, EmptyState, SectionTitle, SourcesList } from './knowledgeUi';
import { PanelTabs, StatusBadge } from './builderUi';

/**
 * The playbook builder's persistent right-hand panel (sticky on wide
 * screens): "Test on a ticket", "Preview answer" and "Backtest" (+ the
 * auto-mode readiness gate). Controlled by the builder so "Save & test" and
 * the ⋮ → Backtest item can switch it.
 */
export const PANEL_TABS = [
  { id: 'test', label: 'Test on a ticket', icon: FlaskConical },
  { id: 'preview', label: 'Preview answer', icon: Eye },
  { id: 'backtest', label: 'Backtest', icon: History },
];

/**
 * "Preview answer": the newest drafted test of this playbook exactly as the
 * requester would read it — or, before any test, a SAMPLE built from the
 * best-matching published article (no model call), clearly labelled.
 */
export function PreviewAnswer({ playbookId, refreshKey = 0 }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!playbookId) return undefined;
    let cancelled = false;
    setError(null);
    Promise.resolve()
      .then(() => knowledgeAPI.playbookPreview(playbookId))
      .then((res) => { if (!cancelled) setData(res?.data || { latest: null, sample: null }); })
      .catch((err) => { if (!cancelled) setError(err?.message || 'Could not load the preview'); });
    return () => { cancelled = true; };
  }, [playbookId, refreshKey]);

  if (!playbookId) return <p className="px-1 py-6 text-center text-[13px] text-muted-foreground">Save the playbook first, then preview its answer here.</p>;
  if (error) return <p className="text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>;
  if (!data) {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground" role="status">
        <Activity className="h-5 w-5 animate-spin" aria-hidden="true" /> Loading the preview&hellip;
      </div>
    );
  }
  const { latest, sample } = data;
  if (!latest && !sample) {
    return (
      <EmptyState icon={MailOpen} title="Nothing to preview yet">
        Test the playbook on a ticket, or publish an article in its category &mdash; the preview is built from it.
      </EmptyState>
    );
  }
  return (
    <div className="space-y-3 animate-fadeIn" data-testid="preview-answer">
      {latest ? (
        <div className="space-y-1" data-testid="preview-latest">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone="info">Last test</StatusBadge>
            <span className="text-xs text-muted-foreground">
              {latest.ticketRef}{latest.ticketSubject ? ` · ${latest.ticketSubject}` : ''} · {timeAgo(latest.createdAt)}
            </span>
          </div>
          {latest.verdict && (
            <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300" data-testid="preview-not-answerable">
              <AlertTriangle className="mt-px h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
              The answer check marked this test &ldquo;Not answerable&rdquo;, so it would not have been suggested. This is the draft it wrote &mdash; open the run to see which step the knowledge didn&rsquo;t cover.
            </p>
          )}
          {latest.outdated && (
            <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300" data-testid="preview-outdated">
              <AlertTriangle className="mt-px h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
              Tested on version {latest.playbookVersion}; the playbook has changed since. Test again to refresh it.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-1" data-testid="preview-sample">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone="violet">Sample</StatusBadge>
            <span className="text-xs text-muted-foreground">Not a real answer</span>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Built without AI from{' '}
            <Link to={sample.article.url} className="tp-focus-ring rounded font-medium text-foreground/85 hover:underline">{sample.article.title}</Link>
            {sample.article.section ? ` › ${sample.article.section}` : ''}, with the lines every answer carries. It never shows a ticket&rsquo;s answer: a real one is written for each ticket from your instructions and knowledge &mdash; use &ldquo;Test on a ticket&rdquo; to see one.
          </p>
        </div>
      )}
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/80">What the requester reads</p>
      <DraftPreview subject={latest ? latest.draftSubject : sample.subject} html={latest ? latest.draftHtml : sample.html} />
      <div>
        <p className="mb-1.5 text-xs font-medium text-foreground/85">Sources</p>
        <SourcesList sources={(latest ? latest.sources : sample.sources) || []} onlyCited={Boolean(latest)} />
      </div>
      {latest?.id && (
        <Link to={`/knowledge/activity/${latest.id}`} className="tp-focus-ring inline-flex items-center gap-1 rounded text-xs font-medium text-primary hover:underline">
          Open this run in Activity
        </Link>
      )}
    </div>
  );
}

export default function PlaybookSidePanel({
  playbookId, dirty = false, canManage = false, tab, onTab, runRequest = 0, readiness = null,
}) {
  const [refreshKey, setRefreshKey] = useState(0);
  const tabs = canManage ? PANEL_TABS : PANEL_TABS.filter((t) => t.id === 'preview');
  const active = tabs.some((t) => t.id === tab) ? tab : tabs[0].id;
  return (
    <aside className="tp-card p-3 sm:p-4" aria-label="Test and preview" data-testid="playbook-side-panel">
      <PanelTabs tabs={tabs} activeId={active} onSelect={onTab} ariaLabel="Test and preview" idPrefix="pb-panel" />
      <div className="mt-4">
        {tabs.map((t) => (
          <div
            key={t.id}
            role="tabpanel"
            id={`pb-panel-panel-${t.id}`}
            aria-labelledby={`pb-panel-tab-${t.id}`}
            hidden={t.id !== active}
            tabIndex={-1}
            className="focus:outline-none"
          >
            {/* Test stays mounted so a running test and its result survive a look at the preview. */}
            {t.id === 'test' && (
              <PlaybookTestBox
                playbookId={playbookId}
                dirty={dirty}
                runRequest={runRequest}
                onResult={(run) => { if (run?.status === 'drafted') setRefreshKey((k) => k + 1); }}
              />
            )}
            {t.id === 'preview' && active === 'preview' && <PreviewAnswer playbookId={playbookId} refreshKey={refreshKey} />}
            {t.id === 'backtest' && (
              <div className="space-y-5">
                <PlaybookBacktestBox playbookId={playbookId} dirty={dirty} />
                {readiness && (
                  <div className="border-t border-border/70 pt-4" data-testid="playbook-readiness">
                    <SectionTitle hint="The bar a playbook must clear before it may send on its own. Checked on the server.">Ready for auto mode?</SectionTitle>
                    <ReadinessList readiness={readiness} autoModeAllowed={readiness.autoModeAllowed === true} />
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </aside>
  );
}
