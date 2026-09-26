/**
 * "Preview answer" for the playbook builder (Knowledge redesign, 26 Sep 2026).
 *
 *   latest  the newest drafted TEST run of the playbook ("Test on a ticket"),
 *           exactly as it was stored: disclosure line, answer, follow-up
 *           footer, sources. Flags when the playbook has changed since.
 *   sample  when there is no drafted test yet: a SAMPLE built WITHOUT any
 *           model call from the playbook's best-matching published article
 *           (keyword search over the playbook's name + keywords, in its
 *           category and knowledge scope) — the matching section as the body,
 *           wrapped in the same disclosure line and footer a real answer gets.
 *           Always labelled "Sample" in the UI; never stored, never sent.
 *
 * Read-only: no writes, no mail, no provider calls, no embeddings. The runner
 * is imported lazily (its buildPreview / _decorate), so route tests that mock
 * the runner with a partial module still load.
 */
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import autoHelpPlaybookService from './autoHelpPlaybookService.js';
import knowledgeArticleService from './knowledgeArticleService.js';

const SAMPLE_CHARS = 1500;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Plain section text → simple mail HTML: runs of "1. …" / "- …" lines become
 * a list, other lines paragraphs. Exported for tests.
 */
export function sectionTextToHtml(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = [];
  let list = null;
  const flush = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  for (const line of lines) {
    const numbered = line.match(/^\d{1,2}[.)]\s+(.+)$/);
    const bullet = line.match(/^[-*•]\s+(.+)$/);
    const item = numbered?.[1] || bullet?.[1] || null;
    const tag = numbered ? 'ol' : 'ul';
    if (item) {
      if (!list || list.tag !== tag) { flush(); list = { tag, items: [] }; }
      list.items.push(item);
    } else {
      flush();
      out.push(`<p>${escapeHtml(line)}</p>`);
    }
  }
  flush();
  return out.join('');
}

function clip(text, max) {
  const s = String(text || '').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

class AutoHelpPreviewService {
  async _latestTest(workspaceId, playbook) {
    const row = await Promise.resolve()
      .then(() => prisma.autoHelpRun.findFirst({
        where: { workspaceId: Number(workspaceId), playbookId: playbook.id, trigger: 'test', status: 'drafted' },
        orderBy: { createdAt: 'desc' },
      }))
      .catch((err) => { logger.warn(`Auto-help preview: latest test lookup failed (ws ${workspaceId}): ${err.message}`); return null; });
    if (!row) return null;
    const { default: autoHelpRunner } = await import('./autoHelpRunner.js');
    const [view] = await autoHelpRunner._decorate(workspaceId, [row]);
    return {
      ...view,
      // The test ran an older version of the playbook: say so next to it.
      outdated: Number(row.playbookVersion || 1) !== Number(playbook.version || 1),
    };
  }

  async _sample(workspaceId, playbook, settings) {
    const scope = playbook.kbScope || {};
    const query = [playbook.name, ...(playbook.match?.keywords || [])].join(' ').trim();
    if (!query) return null;
    const hits = await Promise.resolve()
      .then(() => knowledgeArticleService.search(workspaceId, query, {
        limit: 1,
        tags: scope.mode === 'tags' ? scope.tags : null,
        categoryId: playbook.categoryId,
        subcategoryId: (playbook.subcategoryIds || [])[0] || null,
        minScore: 0,
        queryVector: null, // keyword only: a sample never costs an embedding call
      }))
      .catch(() => []);
    const hit = hits?.[0];
    if (!hit) return null;
    const sectionText = clip(hit.section?.text || hit.snippet || '', SAMPLE_CHARS);
    if (!sectionText) return null;
    const heading = hit.section?.heading || '';
    const body = [
      heading ? `<p><strong>${escapeHtml(heading)}</strong></p>` : '',
      sectionTextToHtml(sectionText),
    ].join('');
    const workspace = await Promise.resolve()
      .then(() => prisma.workspace.findUnique({ where: { id: Number(workspaceId) }, select: { name: true } }))
      .catch(() => null);
    const { buildPreview } = await import('./autoHelpRunner.js');
    const preview = buildPreview({
      subject: `Re: ${hit.title}`,
      html: body,
      text: sectionText,
      settings,
      workspaceName: workspace?.name || null,
      followUp: playbook.followUp,
    });
    return {
      subject: preview.subject,
      html: preview.html,
      article: { id: hit.id, title: hit.title, section: heading || null, url: `/knowledge/articles/${hit.id}` },
      sources: [{
        sourceId: `article:${hit.id}`, type: 'article', id: hit.id, title: hit.title,
        ...(heading ? { section: heading } : {}), cited: true, url: `/knowledge/articles/${hit.id}`,
      }],
    };
  }

  /** { latest, sample } — sample only when there is no drafted test run. */
  async forPlaybook(workspaceId, playbookId) {
    const playbook = await autoHelpPlaybookService.get(workspaceId, playbookId);
    const latest = await this._latestTest(workspaceId, playbook);
    if (latest) return { latest, sample: null };
    const settings = await autoHelpPlaybookService.getSettings(workspaceId);
    return { latest: null, sample: await this._sample(workspaceId, playbook, settings) };
  }
}

const autoHelpPreviewService = new AutoHelpPreviewService();
export default autoHelpPreviewService;
export { AutoHelpPreviewService };
