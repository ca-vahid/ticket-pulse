import { Component } from 'react';
import { AlertTriangle, ChevronDown, RefreshCw } from 'lucide-react';

/**
 * Error boundary (QA 08-07 #10 — "the page refreshes itself").
 *
 * Before this existed, ANY render-time throw (e.g. a dnd-kit overlay racing a
 * refetch) unmounted the whole React tree — a white screen users read as a
 * spontaneous refresh. This catches the throw and shows a calm tp-styled
 * fallback instead.
 *
 * Variants:
 *  - "page" (default): full-height card on the app backdrop — used around the
 *    router outlet in App.jsx.
 *  - "inline": compact card that stays inside the failed section's layout —
 *    used around risky subtrees (e.g. TicketBoard) so one crashing widget
 *    doesn't take the page down with it.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, errorInfo: null, showDetail: false };
    this.handleReload = this.handleReload.bind(this);
    this.toggleDetail = this.toggleDetail.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, errorInfo) {
    // Surface the real crash in the console — the fallback intentionally
    // keeps the scary detail collapsed.
    console.error('ErrorBoundary caught a render error:', error, errorInfo);
    this.setState({ errorInfo });
  }

  handleReload() {
    window.location.reload();
  }

  toggleDetail() {
    this.setState((s) => ({ showDetail: !s.showDetail }));
  }

  renderFallback() {
    const { variant = 'page', label = null } = this.props;
    const { error, errorInfo, showDetail } = this.state;
    const detailText = [
      error?.message || String(error),
      error?.stack,
      errorInfo?.componentStack,
    ].filter(Boolean).join('\n\n');

    const card = (
      <div className="tp-card mx-auto w-full max-w-md p-6 text-center shadow-soft" role="alert">
        <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-red-50">
          <AlertTriangle className="h-5 w-5 text-red-500" aria-hidden="true" />
        </div>
        <h2 className="text-base font-semibold text-slate-900">Something went wrong</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {label ? `The ${label} hit an unexpected error.` : 'This view hit an unexpected error.'}
          {' '}Your data is safe — reloading usually fixes it.
        </p>
        <div className="mt-4 flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={this.handleReload}
            className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-blue-700"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" /> Reload
          </button>
          <button
            type="button"
            onClick={this.toggleDetail}
            aria-expanded={showDetail}
            className="tp-focus-ring inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50"
          >
            Details
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showDetail ? 'rotate-180' : ''}`} aria-hidden="true" />
          </button>
        </div>
        {showDetail && (
          <pre className="settings-scrollbar mt-4 max-h-48 overflow-auto rounded-md bg-slate-50 p-3 text-left text-[11px] leading-relaxed text-slate-600">
            {detailText || 'No further detail available.'}
          </pre>
        )}
      </div>
    );

    if (variant === 'inline') {
      return <div className="animate-fadeIn py-6">{card}</div>;
    }
    return (
      <div className="tp-page-backdrop flex min-h-screen items-center justify-center p-6">
        <div className="animate-fadeIn w-full">{card}</div>
      </div>
    );
  }

  render() {
    if (this.state.error) return this.renderFallback();
    return this.props.children;
  }
}
