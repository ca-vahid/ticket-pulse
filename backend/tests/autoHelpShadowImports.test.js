import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The Auto-help runner and its tools must not even be able to reach a mail
 * lane, the proposed-reply store, the FreshService mirror or the ticket write
 * service. P1 adds exactly ONE door out: a dynamic import of
 * autoHelpDeliveryService, made only to stage an approve-mode answer; the
 * delivery and follow-up services send only through the reply path
 * (ticketService.addReply), never a mail client directly. Reads every static
 * and dynamic import specifier from the source and checks it against an
 * allowlist + denylist.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, '..', 'src', 'services', rel), 'utf8');

function dynamicImportsOf(source) {
  return [...source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
}

function importsOf(source) {
  const specs = [];
  for (const m of source.matchAll(/^\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm)) specs.push(m[1]);
  for (const m of source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]);
  for (const m of source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]);
  return specs;
}

const FORBIDDEN = /(mail|sendgrid|graph|smtp|proposedReply|proposed-reply|mirror|ticketService|freshServiceAction|freshservice|notificationWorkflowEngine|replyService|webhook)/i;

describe('Auto-help shadow-only imports', () => {
  test('autoHelpRunner.js imports exactly the expected modules, none that can send', () => {
    const specs = importsOf(read('autoHelpRunner.js'));
    expect(specs.filter((s) => FORBIDDEN.test(s))).toEqual([]);
    expect(specs.sort()).toEqual([
      '../utils/errors.js',
      '../utils/logger.js',
      '../utils/ticketOrigin.js',
      './aiProviders/providerGateway.js',
      './autoHelpDeliveryService.js',
      './autoHelpLocks.js',
      './autoHelpOutcomes.js',
      './autoHelpPlaybookService.js',
      './autoHelpTools.js',
      './knowledgeArticleService.js',
      './notificationWorkflowOutputGuard.js',
      './notificationWorkflowSignatureService.js',
      './prisma.js',
      './resolutionReasonService.js',
      './statusService.js',
      './ticketEmbeddingService.js',
      './ticketParkService.js',
      './tokenUsageService.js',
      'sanitize-html',
    ].sort());
  });

  test('the runner reaches delivery only through one dynamic import (approve-mode staging)', () => {
    const source = read('autoHelpRunner.js');
    expect(dynamicImportsOf(source).filter((s) => s === './autoHelpDeliveryService.js')).toHaveLength(1);
    expect(source).not.toMatch(/^\s*import[^(]*['"]\.\/autoHelpDeliveryService\.js['"]/m);
  });

  test('delivery and follow-up never import a mail client or the mirror directly', () => {
    const MAIL = /(sendgrid|graphMail|smtp|mailboxIngest|mirrorService|freshServiceAction|notificationWorkflowEngine)/i;
    for (const file of ['autoHelpDeliveryService.js', 'autoHelpFollowUpService.js']) {
      const specs = importsOf(read(file));
      expect(specs.filter((s) => MAIL.test(s))).toEqual([]);
    }
    // Requester-facing text goes through the one reply path, loaded lazily.
    expect(dynamicImportsOf(read('autoHelpDeliveryService.js'))).toEqual(expect.arrayContaining(['./ticketService.js', './ticketProposedReplyService.js']));
  });

  test('autoHelpTools.js imports only read-side modules', () => {
    const specs = [...new Set(importsOf(read('autoHelpTools.js')))];
    expect(specs.filter((s) => FORBIDDEN.test(s))).toEqual([]);
    expect(specs.sort()).toEqual([
      '../utils/logger.js',
      './knowledgeArticleService.js',
      './prisma.js',
      './statusService.js',
      './ticketSimilaritySearchService.js',
    ].sort());
  });
});
