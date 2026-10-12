import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import DOMPurify from 'dompurify';
import { ArrowLeft, Sparkles } from 'lucide-react';
import { knowledgeAPI } from '../../services/api';
import FancySelect from '../common/FancySelect';
import { inputClass, labelClass, textareaClass } from './knowledgeUi';

/**
 * "From rough notes" (plans/KNOWLEDGE_SIMPLIFY_PLAN.md section 8): paste what
 * you know the way you would tell a colleague; Tidy rewrites it into the
 * house style (a title, numbered steps, when it does not apply) using only
 * what the notes say. Notes on the left, the proposal on the right; nothing
 * is saved until you say so. Someone who may write there gets a draft to
 * finish in the editor; someone who may only propose sends it to a person
 * with the skill.
 */
export default function NotesToArticle({ categories = [], rights = null }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [notes, setNotes] = useState('');
  const [title, setTitle] = useState('');
  const [categoryId, setCategoryId] = useState(Number(params.get('c')) || '');
  const [subcategoryId, setSubcategoryId] = useState(Number(params.get('s')) || '');
  const [proposal, setProposal] = useState(null);
  const [busy, setBusy] = useState(null); // 'tidy' | 'save'
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(false);

  const top = categories.find((c) => c.id === Number(categoryId));
  const target = Number(subcategoryId) || Number(categoryId) || null;
  const mine = rights?.isAdmin ? { write: true, propose: true } : (rights?.categories?.[target] || rights?.categories?.[Number(categoryId)] || null);
  const canWrite = rights?.isAdmin === true || mine?.write === true;
  const html = useMemo(() => DOMPurify.sanitize(proposal?.bodyHtml || '', { USE_PROFILES: { html: true } }), [proposal]);

  const tidy = async () => {
    setBusy('tidy');
    setError(null);
    try {
      const res = await knowledgeAPI.tidy({ text: notes, title });
      setProposal(res?.data || null);
      if (!title && res?.data?.title) setTitle(res.data.title);
    } catch (err) {
      setError(err?.message || 'The notes could not be tidied');
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy('save');
    setError(null);
    const body = { title: (title || proposal?.title || '').trim(), bodyHtml: proposal?.bodyHtml || '' };
    try {
      if (canWrite) {
        const res = await knowledgeAPI.createArticle({ ...body, status: 'draft', categoryId: Number(categoryId) || null, subcategoryId: Number(subcategoryId) || null, tags: [] });
        navigate(`/knowledge/articles/${res.data.id}`);
      } else {
        await knowledgeAPI.proposeSuggestion({ kind: 'new_article', title: body.title, categoryId: Number(categoryId) || null, subcategoryId: Number(subcategoryId) || null, proposed: body, why: 'Proposed from notes.' });
        setSent(true);
      }
    } catch (err) {
      setError(err?.message || 'Could not save');
    } finally {
      setBusy(null);
    }
  };

  if (sent) {
    return (
      <div className="tp-card mx-auto max-w-xl p-6 text-center" data-testid="notes-sent">
        <p className="text-sm font-semibold text-foreground">Sent to someone with the skill for that category.</p>
        <p className="mt-1 text-sm text-muted-foreground">They will check it and publish it, or come back to you.</p>
        <Link to="/knowledge/library" className="tp-focus-ring mt-4 inline-block rounded text-sm font-medium text-primary hover:underline">Back to the Library</Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl" data-testid="notes-to-article">
      <Link to="/knowledge/library" className="tp-focus-ring mb-3 inline-flex items-center gap-1 rounded text-[13px] text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> Library
      </Link>
      <div className="grid gap-5 lg:grid-cols-2">
        <section className="tp-card p-4 sm:p-5" aria-labelledby="notes-title">
          <h2 id="notes-title" className="text-sm font-semibold text-foreground">Your notes</h2>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">Write it the way you would tell a colleague: what the problem is, what fixes it, and when it does not work. No names, passwords or server addresses.</p>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={12}
            maxLength={12000}
            aria-label="What you know"
            placeholder={'Dock shows no display after sleep.\nUnplug the dock for 30 seconds, plug it back in, then the monitor cables.\nIf it is a WD19, update the firmware from Company Portal first.\nDoes not help when the laptop itself shows nothing.'}
            className={`${textareaClass} mt-3 font-[inherit]`}
          />
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <span className={labelClass}>Category</span>
              <FancySelect
                value={categoryId}
                onChange={(v) => { setCategoryId(Number(v) || ''); setSubcategoryId(''); }}
                options={[{ value: '', label: 'Pick a category' }, ...categories.map((c) => ({ value: c.id, label: c.name }))]}
                aria-label="Category"
                data-testid="notes-category"
              />
            </div>
            <div>
              <span className={labelClass}>Subcategory</span>
              <FancySelect
                value={subcategoryId}
                onChange={(v) => setSubcategoryId(Number(v) || '')}
                options={[{ value: '', label: top?.subcategories?.length ? 'The whole category' : 'None' }, ...(top?.subcategories || []).map((s) => ({ value: s.id, label: s.name }))]}
                disabled={!top?.subcategories?.length}
                aria-label="Subcategory"
                data-testid="notes-subcategory"
              />
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button type="button" disabled={busy !== null || notes.trim().length < 40} onClick={tidy} className="tp-focus-ring inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50">
              <Sparkles className="h-4 w-4" aria-hidden="true" /> {busy === 'tidy' ? 'Tidying…' : proposal ? 'Tidy again' : 'Tidy'}
            </button>
            <span className="text-xs text-muted-foreground">Uses only what your notes say. Nothing is saved yet.</span>
          </div>
          {error && <p className="mt-3 text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>}
        </section>

        <section className="tp-card p-4 sm:p-5" aria-labelledby="notes-proposal">
          <h2 id="notes-proposal" className="text-sm font-semibold text-foreground">The article</h2>
          {!proposal ? (
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">Tidy turns your notes into a short article: a title, numbered steps, and when it does not apply. You can change anything before it is published.</p>
          ) : (
            <>
              <label htmlFor="notes-article-title" className={`${labelClass} mt-3`}>Title</label>
              <input id="notes-article-title" value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} className={inputClass} />
              <div className="tp-article mt-3 max-h-[26rem] overflow-auto rounded-lg border border-border p-3" dangerouslySetInnerHTML={{ __html: html }} data-testid="notes-preview" />
              {proposal.reviewerNotes && (
                <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] leading-relaxed text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100" data-testid="notes-missing">
                  <span className="font-medium">Before you publish: </span>{proposal.reviewerNotes}
                </p>
              )}
              <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4">
                <button type="button" disabled={busy !== null || !categoryId || !(title || '').trim()} onClick={save} className="tp-focus-ring h-9 rounded-lg bg-primary px-3.5 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50" data-testid="notes-save">
                  {busy === 'save' ? 'Saving…' : canWrite ? 'Continue in the editor' : 'Send to someone with the skill'}
                </button>
                {!categoryId && <span className="text-xs text-muted-foreground">Pick a category first.</span>}
                {categoryId && !canWrite && <span className="text-xs text-muted-foreground">You can propose here; someone with the skill publishes it.</span>}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
