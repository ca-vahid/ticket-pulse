import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  AlertCircle,
  BarChart3,
  CheckCircle2,
  ChevronDown,
  FileDown,
  Lightbulb,
  Loader2,
  MessageCircle,
  MessageSquare,
  Printer,
  Search,
  Sparkles,
  Tags,
  ThumbsUp,
  Trophy,
  UsersRound,
} from 'lucide-react';
import { summitAPI } from '../services/api';

function safeDate(value, options = {}) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString([], options);
}

function normalizeReport(data) {
  return {
    session: data?.session || null,
    votes: {
      participantCount: Number(data?.votes?.participantCount || 0),
      totals: Array.isArray(data?.votes?.totals) ? data.votes.totals : [],
      mergeSuggestions: Array.isArray(data?.votes?.mergeSuggestions) ? data.votes.mergeSuggestions : [],
      categorySuggestions: Array.isArray(data?.votes?.categorySuggestions) ? data.votes.categorySuggestions : [],
      participantStats: Array.isArray(data?.votes?.participantStats) ? data.votes.participantStats : [],
    },
    feedback: {
      items: Array.isArray(data?.feedback?.items) ? data.feedback.items : [],
      counts: {
        working: Number(data?.feedback?.counts?.working || 0),
        attention: Number(data?.feedback?.counts?.attention || 0),
        votes: Number(data?.feedback?.counts?.votes || 0),
        comments: Number(data?.feedback?.counts?.comments || 0),
      },
    },
    generatedAt: data?.generatedAt || new Date().toISOString(),
  };
}

function voteCount(votes, itemId, voteType = 'support') {
  return votes?.totals?.find(vote => vote.itemId === itemId && vote.voteType === voteType)?.count || 0;
}

function feedbackScore(item) {
  return Number(item.supportCount || 0) * 3 + Number(item.commentCount || 0);
}

function sortFeedback(items = []) {
  return [...items].sort((a, b) => (
    feedbackScore(b) - feedbackScore(a)
    || Number(b.supportCount || 0) - Number(a.supportCount || 0)
    || new Date(a.createdAt || 0) - new Date(b.createdAt || 0)
  ));
}

function StatCard({ label, value, icon: Icon, tone = 'cyan' }) {
  const toneClass = {
    cyan: 'border-cyan-300/30 bg-cyan-400/10 text-cyan-200',
    emerald: 'border-emerald-300/30 bg-emerald-400/10 text-emerald-200',
    amber: 'border-amber-300/30 bg-amber-400/10 text-amber-200',
    violet: 'border-violet-300/30 bg-violet-400/10 text-violet-200',
  }[tone];

  return (
    <div className={`rounded-2xl border p-4 shadow-xl shadow-black/10 ${toneClass}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-300">{label}</div>
        <Icon className="h-5 w-5" />
      </div>
      <div className="mt-3 text-3xl font-black text-white">{value}</div>
    </div>
  );
}

function FeedbackCard({ item, rank }) {
  const isAttention = item.section === 'attention';
  const [open, setOpen] = useState(false);

  return (
    <article className={`group rounded-2xl border p-4 transition duration-300 hover:-translate-y-1 hover:shadow-2xl ${
      isAttention
        ? 'border-amber-300/25 bg-amber-300/10 shadow-amber-950/10'
        : 'border-emerald-300/25 bg-emerald-300/10 shadow-emerald-950/10'
    }`}>
      <div className="flex items-start gap-3">
        <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-sm font-black ${
          isAttention ? 'bg-amber-300 text-slate-950' : 'bg-emerald-300 text-slate-950'
        }`}>
          {rank}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="break-words text-lg font-bold text-white">{item.title}</h3>
            <span className="rounded-full bg-white/10 px-2.5 py-1 text-xs font-semibold text-slate-300">by {item.participantName || 'Unknown'}</span>
          </div>
          {item.note && <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-sm leading-6 text-slate-300">{item.note}</p>}
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs font-semibold text-slate-300">
            <span className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1"><ThumbsUp className="h-3.5 w-3.5" />{item.supportCount || 0}</span>
            <span className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1"><MessageCircle className="h-3.5 w-3.5" />{item.commentCount || 0}</span>
            <span>{safeDate(item.createdAt, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
          </div>
        </div>
      </div>

      {!!(item.comments || []).length && (
        <div className="mt-4 border-t border-white/10 pt-3">
          <button
            type="button"
            onClick={() => setOpen(value => !value)}
            className="inline-flex items-center gap-2 rounded-lg px-2 py-1 text-xs font-semibold text-slate-300 transition hover:bg-white/10 hover:text-white"
          >
            <ChevronDown className={`h-4 w-4 transition ${open ? 'rotate-180' : ''}`} />
            {open ? 'Hide comments' : `Show ${item.comments.length} comments`}
          </button>
          <div className={`grid transition-all duration-300 ${open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
            <div className="overflow-hidden">
              <div className="mt-3 space-y-2">
                {item.comments.map(comment => (
                  <div key={comment.id} className="rounded-xl border border-white/10 bg-slate-950/70 px-3 py-2">
                    <div className="text-xs font-bold text-cyan-200">{comment.participantName || 'Unknown'}</div>
                    <div className="mt-1 whitespace-pre-wrap text-sm text-slate-300">{comment.text}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </article>
  );
}

function CategoryRow({ category, votes }) {
  const categoryVotes = voteCount(votes, category.id);
  const subcategories = (category.subcategories || []).filter(subcategory => !subcategory.deleted);
  const subVotes = subcategories.reduce((sum, subcategory) => sum + voteCount(votes, subcategory.id), 0);
  const total = categoryVotes + subVotes;

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 transition duration-300 hover:border-cyan-300/30 hover:bg-white/[0.07]">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="truncate text-base font-bold text-white">{category.name}</div>
          <div className="mt-1 text-sm text-slate-400">{subcategories.length} subcategories</div>
        </div>
        <div className="rounded-xl bg-cyan-400/10 px-3 py-2 text-right">
          <div className="text-lg font-black text-cyan-200">{total}</div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400">votes</div>
        </div>
      </div>
      {!!subcategories.length && (
        <div className="mt-3 flex flex-wrap gap-2">
          {subcategories.slice(0, 8).map(subcategory => (
            <span key={subcategory.id} className="rounded-full border border-white/10 bg-slate-950/60 px-2.5 py-1 text-xs font-semibold text-slate-300">
              {subcategory.name}
              {voteCount(votes, subcategory.id) > 0 ? ` (${voteCount(votes, subcategory.id)})` : ''}
            </span>
          ))}
          {subcategories.length > 8 && <span className="rounded-full bg-white/10 px-2.5 py-1 text-xs font-semibold text-slate-400">+{subcategories.length - 8} more</span>}
        </div>
      )}
    </div>
  );
}

export default function SummitReport() {
  const { token } = useParams();
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [sectionFilter, setSectionFilter] = useState('all');
  const [search, setSearch] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    summitAPI.getPublicReport(token)
      .then((res) => {
        if (cancelled) return;
        setReport(normalizeReport(res));
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Could not load summit report');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [token]);

  const analytics = useMemo(() => {
    const sessionState = report?.session?.state || {};
    const categories = (sessionState.categories || []).filter(category => !category.deleted);
    const feedbackItems = sortFeedback(report?.feedback?.items || []);
    const working = sortFeedback(feedbackItems.filter(item => item.section !== 'attention'));
    const attention = sortFeedback(feedbackItems.filter(item => item.section === 'attention'));
    const query = search.trim().toLowerCase();
    const filteredItems = feedbackItems
      .filter(item => sectionFilter === 'all' || item.section === sectionFilter)
      .filter(item => !query || [item.title, item.note, item.participantName].filter(Boolean).join(' ').toLowerCase().includes(query));
    const topCategories = categories
      .map(category => ({
        ...category,
        totalVotes: voteCount(report?.votes, category.id)
          + (category.subcategories || []).filter(subcategory => !subcategory.deleted).reduce((sum, subcategory) => sum + voteCount(report?.votes, subcategory.id), 0),
      }))
      .sort((a, b) => b.totalVotes - a.totalVotes || a.name.localeCompare(b.name));
    const contributors = new Map();
    feedbackItems.forEach((item) => {
      const name = item.participantName || 'Unknown';
      const current = contributors.get(name) || { name, items: 0, votes: 0, comments: 0 };
      current.items += 1;
      current.votes += Number(item.supportCount || 0);
      current.comments += Number(item.commentCount || 0);
      contributors.set(name, current);
    });
    feedbackItems.flatMap(item => item.comments || []).forEach((comment) => {
      const name = comment.participantName || 'Unknown';
      const current = contributors.get(name) || { name, items: 0, votes: 0, comments: 0 };
      current.comments += 1;
      contributors.set(name, current);
    });

    return {
      categories,
      topCategories,
      feedbackItems,
      filteredItems,
      working,
      attention,
      topWorking: working[0] || null,
      topAttention: attention[0] || null,
      topOverall: feedbackItems.slice(0, 6),
      contributors: [...contributors.values()].sort((a, b) => (b.items + b.comments) - (a.items + a.comments) || a.name.localeCompare(b.name)),
    };
  }, [report, search, sectionFilter]);

  const totalFeedbackItems = (report?.feedback?.counts?.working || 0) + (report?.feedback?.counts?.attention || 0);
  const workingPercent = totalFeedbackItems ? Math.round((report.feedback.counts.working / totalFeedbackItems) * 100) : 0;

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 text-white">
        <div className="text-center">
          <Loader2 className="mx-auto h-10 w-10 animate-spin text-cyan-300" />
          <div className="mt-4 text-sm font-semibold text-slate-300">Loading summit report...</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 px-4 text-white">
        <div className="max-w-lg rounded-2xl border border-red-400/30 bg-red-950/40 p-6">
          <AlertCircle className="h-8 w-8 text-red-200" />
          <h1 className="mt-3 text-2xl font-bold">Report unavailable</h1>
          <p className="mt-2 text-slate-300">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <main className="min-h-screen bg-slate-950 text-white">
      <style>{`
        @keyframes reportIn { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
        .summit-report-in { animation: reportIn .35s ease-out both; }
        @media print {
          .no-print { display: none !important; }
          main { background: white !important; color: #0f172a !important; }
        }
      `}</style>
      <div className="pointer-events-none fixed inset-0 opacity-60">
        <div className="absolute left-[-12rem] top-[-12rem] h-96 w-96 rounded-full bg-cyan-500/20 blur-3xl" />
        <div className="absolute right-[-10rem] top-40 h-96 w-96 rounded-full bg-violet-500/20 blur-3xl" />
        <div className="absolute bottom-[-12rem] left-1/3 h-96 w-96 rounded-full bg-emerald-500/10 blur-3xl" />
      </div>

      <div className="relative mx-auto max-w-7xl px-5 py-8">
        <header className="summit-report-in rounded-3xl border border-white/10 bg-white/[0.05] p-6 shadow-2xl shadow-black/20 backdrop-blur">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="flex items-center gap-3">
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-cyan-400 text-slate-950 shadow-lg shadow-cyan-950/30">
                  <Sparkles className="h-6 w-6" />
                </span>
                <div>
                  <div className="text-xs font-bold uppercase tracking-[0.28em] text-cyan-200">BGC Engineering IT Summit</div>
                  <h1 className="mt-1 text-4xl font-black tracking-tight">Workshop Report</h1>
                </div>
              </div>
              <p className="mt-4 max-w-3xl text-base leading-7 text-slate-300">
                Read-only summary of the Categories & Skills workshop and the Working Well / Needs Attention discussion.
              </p>
              <div className="mt-4 flex flex-wrap gap-2 text-xs font-semibold text-slate-300">
                <span className="rounded-full bg-white/10 px-3 py-1">Generated {safeDate(report.generatedAt, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                <span className="rounded-full bg-white/10 px-3 py-1">{report.votes.participantCount} participants</span>
                <span className="rounded-full bg-white/10 px-3 py-1">{analytics.categories.length} categories</span>
              </div>
            </div>
            <div className="no-print flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => window.print()}
                className="inline-flex h-11 items-center gap-2 rounded-xl border border-white/15 bg-white/10 px-4 text-sm font-bold text-white transition hover:-translate-y-0.5 hover:bg-white/15"
              >
                <Printer className="h-4 w-4" />
                Print / PDF
              </button>
              <button
                type="button"
                onClick={() => navigator.clipboard.writeText(window.location.href)}
                className="inline-flex h-11 items-center gap-2 rounded-xl bg-cyan-400 px-4 text-sm font-bold text-slate-950 transition hover:-translate-y-0.5 hover:bg-cyan-300"
              >
                <FileDown className="h-4 w-4" />
                Copy link
              </button>
            </div>
          </div>
        </header>

        <section className="summit-report-in mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4" style={{ animationDelay: '70ms' }}>
          <StatCard label="Working Well" value={report.feedback.counts.working} icon={CheckCircle2} tone="emerald" />
          <StatCard label="Needs Attention" value={report.feedback.counts.attention} icon={MessageSquare} tone="amber" />
          <StatCard label="Feedback Votes" value={report.feedback.counts.votes} icon={ThumbsUp} tone="cyan" />
          <StatCard label="Comments" value={report.feedback.counts.comments} icon={MessageCircle} tone="violet" />
        </section>

        <section className="summit-report-in mt-5 grid gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(360px,.8fr)]" style={{ animationDelay: '120ms' }}>
          <div className="rounded-3xl border border-white/10 bg-white/[0.05] p-5 shadow-2xl shadow-black/10">
            <div className="flex items-center gap-2 text-xl font-black">
              <BarChart3 className="h-5 w-5 text-cyan-300" />
              Key Insights
            </div>
            <div className="mt-5 grid gap-4 md:grid-cols-2">
              <div className="rounded-2xl border border-emerald-300/20 bg-emerald-400/10 p-4">
                <div className="text-xs font-bold uppercase tracking-wide text-emerald-200">Top Working Well</div>
                <div className="mt-2 text-lg font-black">{analytics.topWorking?.title || 'No item yet'}</div>
                {analytics.topWorking && <div className="mt-2 text-sm text-slate-300">{analytics.topWorking.supportCount || 0} votes by {analytics.topWorking.participantName}</div>}
              </div>
              <div className="rounded-2xl border border-amber-300/20 bg-amber-400/10 p-4">
                <div className="text-xs font-bold uppercase tracking-wide text-amber-200">Top Needs Attention</div>
                <div className="mt-2 text-lg font-black">{analytics.topAttention?.title || 'No item yet'}</div>
                {analytics.topAttention && <div className="mt-2 text-sm text-slate-300">{analytics.topAttention.supportCount || 0} votes by {analytics.topAttention.participantName}</div>}
              </div>
            </div>
            <div className="mt-5">
              <div className="mb-2 flex items-center justify-between text-xs font-bold uppercase tracking-wide text-slate-400">
                <span>Feedback balance</span>
                <span>{totalFeedbackItems} total items</span>
              </div>
              <div className="h-4 overflow-hidden rounded-full bg-amber-300/30">
                <div className="h-full rounded-full bg-emerald-400 transition-all duration-700" style={{ width: `${workingPercent}%` }} />
              </div>
              <div className="mt-2 flex justify-between text-sm text-slate-300">
                <span>{workingPercent}% working</span>
                <span>{100 - workingPercent}% attention</span>
              </div>
            </div>
          </div>

          <div className="rounded-3xl border border-white/10 bg-white/[0.05] p-5 shadow-2xl shadow-black/10">
            <div className="flex items-center gap-2 text-xl font-black">
              <UsersRound className="h-5 w-5 text-violet-300" />
              Participation
            </div>
            <div className="mt-4 space-y-2">
              {analytics.contributors.slice(0, 6).map((person, index) => (
                <div key={person.name} className="flex items-center justify-between gap-3 rounded-2xl bg-white/[0.06] px-3 py-2">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/10 text-xs font-black">{index + 1}</span>
                    <span className="min-w-0 truncate text-sm font-bold">{person.name}</span>
                  </div>
                  <span className="rounded-full bg-violet-400/15 px-2.5 py-1 text-xs font-bold text-violet-200">{person.items} items</span>
                </div>
              ))}
              {!analytics.contributors.length && <div className="rounded-2xl bg-white/[0.06] p-4 text-sm text-slate-400">No contributors yet.</div>}
            </div>
          </div>
        </section>

        <section className="summit-report-in mt-5 rounded-3xl border border-white/10 bg-white/[0.05] p-5 shadow-2xl shadow-black/10" style={{ animationDelay: '170ms' }}>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="flex items-center gap-2 text-xl font-black">
                <Trophy className="h-5 w-5 text-cyan-300" />
                Top Feedback Selections
              </div>
              <p className="mt-1 text-sm text-slate-400">Ranked by votes and discussion activity.</p>
            </div>
            <div className="no-print flex flex-col gap-2 sm:flex-row">
              <div className="relative">
                <Search className="absolute left-3 top-3 h-4 w-4 text-slate-500" />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search report"
                  className="h-10 w-full rounded-xl border border-white/10 bg-slate-950/70 pl-9 pr-3 text-sm text-white outline-none transition placeholder:text-slate-500 focus:border-cyan-300 focus:ring-2 focus:ring-cyan-300/20 sm:w-64"
                />
              </div>
              <select
                value={sectionFilter}
                onChange={(event) => setSectionFilter(event.target.value)}
                className="h-10 rounded-xl border border-white/10 bg-slate-950/70 px-3 text-sm font-semibold text-white outline-none transition focus:border-cyan-300 focus:ring-2 focus:ring-cyan-300/20"
              >
                <option value="all">All feedback</option>
                <option value="working">Working Well</option>
                <option value="attention">Needs Attention</option>
              </select>
            </div>
          </div>
          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            {analytics.filteredItems.map((item, index) => <FeedbackCard key={item.itemId} item={item} rank={index + 1} />)}
            {!analytics.filteredItems.length && <div className="rounded-2xl border border-dashed border-white/10 p-8 text-center text-slate-400 lg:col-span-2">No matching feedback items.</div>}
          </div>
        </section>

        <section className="summit-report-in mt-5 grid gap-5 lg:grid-cols-2" style={{ animationDelay: '220ms' }}>
          <div className="rounded-3xl border border-white/10 bg-white/[0.05] p-5 shadow-2xl shadow-black/10">
            <div className="flex items-center gap-2 text-xl font-black">
              <Tags className="h-5 w-5 text-cyan-300" />
              Category Vote Leaders
            </div>
            <div className="mt-4 space-y-3">
              {analytics.topCategories.slice(0, 8).map(category => <CategoryRow key={category.id} category={category} votes={report.votes} />)}
              {!analytics.topCategories.length && <div className="rounded-2xl bg-white/[0.06] p-4 text-sm text-slate-400">No categories available.</div>}
            </div>
          </div>

          <div className="rounded-3xl border border-white/10 bg-white/[0.05] p-5 shadow-2xl shadow-black/10">
            <div className="flex items-center gap-2 text-xl font-black">
              <Lightbulb className="h-5 w-5 text-amber-300" />
              Suggested Category Ideas
            </div>
            <div className="mt-4 space-y-3">
              {report.votes.categorySuggestions.slice(0, 10).map((idea) => (
                <div key={idea.id} className="rounded-2xl border border-amber-300/20 bg-amber-300/10 p-4">
                  <div className="text-base font-bold text-white">{idea.itemLabel}</div>
                  <div className="mt-1 text-sm text-slate-300">by {idea.participantName || 'Unknown'}{idea.value?.parentName ? ` under ${idea.value.parentName}` : ''}</div>
                  {idea.value?.reason && <div className="mt-2 text-sm leading-6 text-slate-400">{idea.value.reason}</div>}
                </div>
              ))}
              {!report.votes.categorySuggestions.length && <div className="rounded-2xl bg-white/[0.06] p-4 text-sm text-slate-400">No category ideas were submitted.</div>}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
