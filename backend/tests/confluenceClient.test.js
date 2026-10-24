import { jest } from '@jest/globals';
import { createConfluenceClient, normalizeSiteUrl, retryAfterMs } from '../src/integrations/confluenceClient.js';
import { storageToArticleHtml, storageWords } from '../src/services/confluenceStorage.js';

/** Confluence Cloud client (QA 10-23 #4): cursor paging, 429 + Retry-After, one site only; storage -> article HTML. */

const SITE = 'https://example.atlassian.net';
const reply = (status, body = {}, headers = {}) => ({
  status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => body,
});

function client(responses) {
  const calls = [];
  const fetchImpl = jest.fn(async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected call ${url}`);
    return typeof next === 'function' ? next(url) : next;
  });
  const sleep = jest.fn(async () => {});
  const c = createConfluenceClient({ siteUrl: `${SITE}/wiki/spaces/IT`, email: 'svc@example.com', apiToken: 'tok-123', fetchImpl, sleep, minGapMs: 0 });
  return { c, calls, fetchImpl, sleep };
}

describe('confluence client', () => {
  test('site address: https only, path dropped', () => {
    expect(normalizeSiteUrl('example.atlassian.net/wiki/home')).toBe(SITE);
    expect(normalizeSiteUrl('http://example.atlassian.net')).toBeNull();
    expect(normalizeSiteUrl('https://user:pw@example.atlassian.net')).toBeNull();
    expect(() => createConfluenceClient({ siteUrl: 'nope', email: 'a@example.com', apiToken: 'x' })).toThrow(/https/);
  });

  test('follows _links.next until it runs out, with basic auth', async () => {
    const { c, calls } = client([
      reply(200, { results: [{ id: 1, title: 'Home', version: { number: 3, createdAt: '2026-01-01T00:00:00Z' } }], _links: { next: '/wiki/api/v2/spaces/9/pages?cursor=abc' } }),
      reply(200, { results: [{ id: 2, title: 'VPN', parentId: 1, version: { number: 1 } }], _links: {} }),
    ]);
    const { pages, complete } = await c.listSpacePages('9');
    expect(complete).toBe(true);
    expect(pages.map((p) => [p.id, p.parentId, p.version])).toEqual([['1', null, 3], ['2', '1', 1]]);
    expect(calls[0].url).toContain('/wiki/api/v2/spaces/9/pages?');
    expect(calls[0].url).toContain('depth=all');
    expect(calls[1].url).toBe(`${SITE}/wiki/api/v2/spaces/9/pages?cursor=abc`);
    expect(calls[0].init.headers.Authorization).toBe(`Basic ${Buffer.from('svc@example.com:tok-123').toString('base64')}`);
  });

  test('a list that hits its bound says it is not complete', async () => {
    const { c } = client([
      reply(200, { results: [{ id: 1 }, { id: 2 }], _links: { next: '/wiki/api/v2/spaces?cursor=x' } }),
    ]);
    const out = await c.listSpaces({ maxItems: 2 });
    expect(out.complete).toBe(false);
    expect(out.spaces).toHaveLength(2);
  });

  test('429 waits for Retry-After and tries again', async () => {
    const { c, sleep } = client([
      reply(429, {}, { 'retry-after': '7' }),
      reply(200, { results: [{ id: 5, key: 'IT', name: 'IT' }] }),
    ]);
    const out = await c.listSpaces();
    expect(out.spaces[0]).toMatchObject({ id: '5', key: 'IT' });
    expect(sleep).toHaveBeenCalledWith(7000);
    expect(retryAfterMs('999')).toBe(60000);
  });

  test('keeps refusing -> a clear error; 401 -> the sign-in message', async () => {
    const many = Array.from({ length: 7 }, () => reply(429, {}, { 'retry-after': '1' }));
    await expect(client(many).c.listSpaces()).rejects.toThrow(/slow down/);
    await expect(client([reply(401)]).c.getPage('1')).rejects.toThrow(/did not accept/);
  });

  test('never follows a next link to another site', async () => {
    const { c } = client([reply(200, { results: [{ id: 1 }], _links: { next: 'https://evil.example.org/wiki/api/v2/spaces?cursor=1' } })]);
    await expect(c.listSpaces()).rejects.toThrow(/another site/);
  });

  test('restrictions and CQL search', async () => {
    const { c, calls } = client([
      reply(200, { restrictions: { user: { results: [{ accountId: 'x' }] }, group: { results: [] } } }),
      reply(200, { restrictions: { user: { results: [] }, group: { results: [] } } }),
      reply(200, { results: [{ id: '44', title: 'VPN', version: { number: 4 }, space: { key: 'IT' } }] }),
    ]);
    expect(await c.hasViewRestriction('1')).toBe(true);
    expect(await c.hasViewRestriction('2')).toBe(false);
    const found = await c.searchUpdatedSince(['IT', 'bad"key'], '2026-10-20T05:07:00Z');
    expect(found.items).toEqual([{ id: '44', title: 'VPN', version: 4, spaceKey: 'IT' }]);
    expect(new URL(calls[2].url).searchParams.get('cql')).toContain('space in ("IT","badkey") AND lastmodified >= "2026-10-20 05:07"');
  });
});

describe('storage format -> article HTML', () => {
  const STORAGE = [
    '<h1>Reset the VPN</h1>',
    '<p>Ask Jordan Smith first. password: hunter22x</p>',
    '<ac:structured-macro ac:name="toc" />',
    '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">bash</ac:parameter><ac:plain-text-body><![CDATA[sudo restart <vpn> && echo ok\n  indented]]></ac:plain-text-body></ac:structured-macro>',
    '<ac:structured-macro ac:name="warning"><ac:rich-text-body><p>Only on <strong>Wi-Fi</strong></p></ac:rich-text-body></ac:structured-macro>',
    '<table><tbody><tr><th>Step</th><td>Do it</td></tr></tbody></table>',
    '<ul><li>one</li><li>two</li></ul>',
    '<ac:image ac:alt="screen"><ri:attachment ri:filename="vpn.png" /></ac:image>',
    '<p><ac:link><ri:page ri:content-title="Other page" /></ac:link> and <ac:link><ri:user ri:account-id="abc" /></ac:link></p>',
    '<ac:task-list><ac:task><ac:task-id>1</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>Reboot</ac:task-body></ac:task></ac:task-list>',
    '<ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">IT-1</ac:parameter></ac:structured-macro>',
  ].join('');

  test('keeps structure, rewrites Confluence parts, drops the rest, scrubs', () => {
    const out = storageToArticleHtml(STORAGE, { siteUrl: 'https://example.atlassian.net', pageId: '42' });
    expect(out.html).toContain('<h2>Reset the VPN</h2>');
    expect(out.html).toContain('<pre><code>sudo restart &lt;vpn&gt; &amp;&amp; echo ok\n  indented</code></pre>');
    expect(out.html).toContain('<blockquote><p><strong>Warning</strong></p><p>Only on <strong>Wi-Fi</strong></p></blockquote>');
    expect(out.html).toContain('<table><tbody><tr><th>Step</th><td>Do it</td></tr></tbody></table>');
    expect(out.html).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(out.html).toContain('href="https://example.atlassian.net/wiki/download/attachments/42/vpn.png"');
    expect(out.html).toContain('Picture: screen (in Confluence)');
    expect(out.html).toContain('Other page');
    expect(out.html).toContain('<ul><li>Reboot</li></ul>');
    expect(out.html).not.toMatch(/ac:|ri:|IT-1|toc/);
    expect(out.html).not.toContain('hunter22x');
    expect(out.html).not.toContain('Jordan Smith');
    expect(out.dropped.sort()).toEqual(['jira', 'toc']);
    expect(out.images).toBe(1);
    expect(out.words).toBeGreaterThan(10);
  });

  test('word count without converting', () => {
    expect(storageWords('<p>one two</p><ac:plain-text-body><![CDATA[three]]></ac:plain-text-body>')).toBe(3);
  });
});
