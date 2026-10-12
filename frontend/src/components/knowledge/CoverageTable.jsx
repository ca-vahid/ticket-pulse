import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { knowledgeAPI } from '../../services/api';
import { coverageNote, coverageSort } from './coverageFormat';

/**
 * The coverage map (plans/KNOWLEDGE_SIMPLIFY_PLAN.md section 11): one row
 * per category for the last 30 days. What came in, what Auto-help did with
 * it, and what the Library holds, so the place where writing something
 * down would help most is at the top. About topics, never about people:
 * "could write" is a count of people with the skill, not a list.
 */
function Num({ value, tone = '' }) {
  const n = Number(value) || 0;
  return <span className={`tabular-nums ${n ? tone || 'text-foreground' : 'text-muted-foreground/50'}`}>{n}</span>;
}

export default function CoverageTable() {
  const [data, setData] = useState(null);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(() => knowledgeAPI.coverage())
      .then((res) => { if (!cancelled) setData(res?.data || null); })
      .catch(() => { if (!cancelled) setData(null); });
    return () => { cancelled = true; };
  }, []);

  const rows = coverageSort(data?.categories || []).filter((c) => c.tickets30 || c.articles || c.openItems);
  if (!rows.length) return null;

  return (
    <section className="tp-card mb-5 overflow-hidden" aria-labelledby="coverage-title" data-testid="coverage-table">
      <div className="px-4 pb-2 pt-4 sm:px-5">
        <h2 id="coverage-title" className="text-sm font-semibold text-foreground">Where writing something down would help most</h2>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">The last {data.days} days, by category. &ldquo;Nothing to answer from&rdquo; is the gap: tickets a written answer could have helped, where the Library had none.</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[46rem] text-left text-[13px]">
          <thead className="border-y border-border text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium sm:px-5">Category</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Tickets</th>
              <th scope="col" className="px-3 py-2 text-right font-medium" title="Tickets a person had to act on: not a gap in the knowledge">Needed a person</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Answered</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Nothing to answer from</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Articles</th>
              <th scope="col" className="px-3 py-2 text-right font-medium" title="People at the level that can write knowledge in this category">Could write</th>
              <th scope="col" className="px-4 py-2 font-medium sm:px-5">What stands out</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {rows.map((c) => (
              <tr key={c.id} data-testid={`coverage-row-${c.id}`}>
                <th scope="row" className="px-4 py-2 font-medium sm:px-5">
                  <Link to={`/knowledge/library?c=${c.id}`} className="tp-focus-ring rounded text-foreground hover:underline">{c.name}</Link>
                </th>
                <td className="px-3 py-2 text-right"><Num value={c.tickets30} /></td>
                <td className="px-3 py-2 text-right"><Num value={c.needsPerson} tone="text-muted-foreground" /></td>
                <td className="px-3 py-2 text-right"><Num value={c.answered} tone="text-emerald-700 dark:text-emerald-300" /></td>
                <td className="px-3 py-2 text-right"><Num value={c.notAnswered + c.searchMisses} tone="text-amber-700 dark:text-amber-300" /></td>
                <td className="px-3 py-2 text-right"><Num value={c.articles} /></td>
                <td className="px-3 py-2 text-right"><Num value={c.couldWrite} tone="text-muted-foreground" /></td>
                <td className="px-4 py-2 text-xs text-muted-foreground sm:px-5">{coverageNote(c)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
