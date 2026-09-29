import { Fragment } from 'react';
import { GuardedLink } from './knowledgeUi';
import { playbookSummaryParts } from './knowledgeFormat';

/**
 * One plain line saying what a playbook does (Knowledge v2, MEGA 09-28 §6.8):
 * "Answers tickets in 7 subcategories · Stays quiet on 6 playbook rules +
 * 6 workspace rules · Can quote 3 articles in its category (12 published):
 * A, B, C". Built from the server's `summary`; the article titles link to the
 * article through the unsaved-changes guard.
 */
export default function PlaybookSummary({ summary, className = '', small = false, testId = 'playbook-summary' }) {
  const parts = playbookSummaryParts(summary);
  if (!parts.length) return null;
  const articles = summary?.articles || [];
  return (
    <p className={`${small ? 'text-xs' : 'text-[13px]'} leading-relaxed text-muted-foreground ${className}`} data-testid={testId}>
      {parts.map((p, i) => (
        <Fragment key={p.key}>
          {i > 0 && ' · '}
          <span>{p.text}</span>
        </Fragment>
      ))}
      {articles.length > 0 && (
        <>
          {': '}
          {articles.map((a, i) => (
            <Fragment key={a.id}>
              {i > 0 && ', '}
              <GuardedLink to={`/knowledge/articles/${a.id}`} className="tp-focus-ring rounded font-medium text-primary hover:underline">
                {a.title || `Article #${a.id}`}
              </GuardedLink>
            </Fragment>
          ))}
        </>
      )}
    </p>
  );
}
