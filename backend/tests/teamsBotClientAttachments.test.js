import { jest } from '@jest/globals';

/** QA 10-01 #3: which token a Teams file URL may be fetched with, and the bounded download. */

const axiosMock = { post: jest.fn(), get: jest.fn() };
jest.unstable_mockModule('axios', () => ({ default: axiosMock }));

process.env.TEAMS_BOT_APP_ID = 'app';
process.env.TEAMS_BOT_APP_PASSWORD = 'pw';
process.env.TEAMS_BOT_TENANT_ID = 'tenant';

const { attachmentAuthFor, downloadAttachment } = await import('../src/integrations/teamsBotClient.js');

beforeEach(() => {
  jest.clearAllMocks();
  axiosMock.post.mockImplementation(async (_url, body) => ({ data: { access_token: `tok-${String(body.get('scope')).includes('botframework') ? 'bot' : 'graph'}`, expires_in: 3600 } }));
  axiosMock.get.mockResolvedValue({ data: Buffer.from([0x89, 0x50, 0x4e, 0x47]), headers: { 'content-type': 'image/png; charset=binary' } });
});

test('Bot Connector hosts get the bot token, Graph the Graph token, SharePoint none, anything else is refused', () => {
  expect(attachmentAuthFor('https://smba.trafficmanager.net/amer/v3/attachments/1/views/original')).toBe('bot');
  expect(attachmentAuthFor('https://smba.infra.gcc.teams.microsoft.com/v3/attachments/1')).toBe('bot');
  expect(attachmentAuthFor('https://custom.region.example/v3/attachments/1', 'https://custom.region.example/')).toBe('bot');
  expect(attachmentAuthFor('https://graph.microsoft.com/v1.0/chats/x/messages/1/hostedContents/y/$value')).toBe('graph');
  expect(attachmentAuthFor('https://bgc.sharepoint.com/personal/x/file.png?tempauth=1')).toBe('none');
  expect(attachmentAuthFor('https://evil.example/x.png')).toBeNull();
  expect(attachmentAuthFor('http://smba.trafficmanager.net/x')).toBeNull();
  expect(attachmentAuthFor('https://smba.trafficmanager.net.evil.example/x')).toBeNull();
  expect(attachmentAuthFor('not a url')).toBeNull();
});

test('a pasted picture is fetched with the bot token, bounded in size', async () => {
  const out = await downloadAttachment('https://smba.trafficmanager.net/amer/v3/attachments/1/views/original', { maxBytes: 1000 });
  expect(out.contentType).toBe('image/png');
  expect(out.buffer.length).toBe(4);
  const [, opts] = axiosMock.get.mock.calls[0];
  expect(opts).toMatchObject({ responseType: 'arraybuffer', maxContentLength: 1000, headers: { Authorization: 'Bearer tok-bot' } });
});

test('a SharePoint download link is fetched without any token; a stranger host never sees one', async () => {
  await downloadAttachment('https://bgc.sharepoint.com/dl/1');
  expect(axiosMock.get.mock.calls[0][1].headers).toEqual({});
  await expect(downloadAttachment('https://evil.example/x.png')).rejects.toThrow(/not on a Microsoft Teams host/);
  expect(axiosMock.get).toHaveBeenCalledTimes(1);
});
