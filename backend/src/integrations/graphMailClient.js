import { ClientSecretCredential } from '@azure/identity';
import { Client } from '@microsoft/microsoft-graph-client';
import { TokenCredentialAuthenticationProvider } from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js';
import config from '../config/index.js';
import logger from '../utils/logger.js';

class GraphMailClient {
  constructor() {
    this._client = null;
  }

  _getClient() {
    if (this._client) return this._client;

    const { tenantId, clientId, clientSecret } = config.graph;
    if (!tenantId || !clientId || !clientSecret) {
      throw new Error('Azure Graph API credentials not configured (AZURE_GRAPH_TENANT_ID, AZURE_GRAPH_CLIENT_ID, AZURE_GRAPH_CLIENT_SECRET)');
    }

    const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
    const authProvider = new TokenCredentialAuthenticationProvider(credential, {
      scopes: ['https://graph.microsoft.com/.default'],
    });

    this._client = Client.initWithMiddleware({ authProvider });
    return this._client;
  }

  isConfigured() {
    return !!(config.graph.tenantId && config.graph.clientId && config.graph.clientSecret);
  }

  /**
   * Fetch emails received after a given timestamp.
   * @param {string} mailbox - Email address of the shared mailbox
   * @param {Date} since - Only return emails after this time
   * @param {number} [top=25] - Max emails to return
   * @returns {Promise<Array>} Array of email objects
   */
  async getNewEmails(mailbox, since, top = 25) {
    const client = this._getClient();
    const sinceISO = since.toISOString();

    try {
      const response = await client
        .api(`/users/${mailbox}/mailFolders/inbox/messages`)
        .filter(`receivedDateTime gt ${sinceISO}`)
        .orderby('receivedDateTime desc')
        .top(top)
        .select('id,subject,from,receivedDateTime,bodyPreview,isRead,conversationId')
        .get();

      const emails = response.value || [];

      logger.debug('Graph API: fetched emails', {
        mailbox,
        since: sinceISO,
        count: emails.length,
      });

      return emails.map((e) => ({
        id: e.id,
        subject: e.subject || '',
        from: e.from?.emailAddress?.address || '',
        fromName: e.from?.emailAddress?.name || '',
        receivedAt: new Date(e.receivedDateTime),
        bodyPreview: e.bodyPreview || '',
        conversationId: e.conversationId,
      }));
    } catch (error) {
      logger.error('Graph API: failed to fetch emails', {
        mailbox,
        error: error.message,
        code: error.code,
      });
      throw error;
    }
  }

  /**
   * Full messages for ticket ingestion: body, recipients, RFC Message-ID and
   * In-Reply-To/References headers (for threading replies back to tickets).
   * Returned oldest-first so ingestion processes chronologically.
   */
  async getInboxMessagesForIngest(mailbox, since, top = 25) {
    const client = this._getClient();
    try {
      const response = await client
        .api(`/users/${mailbox}/mailFolders/inbox/messages`)
        .filter(`receivedDateTime gt ${since.toISOString()}`)
        .orderby('receivedDateTime desc')
        .top(top)
        .select('id,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,body,conversationId,internetMessageId,internetMessageHeaders,hasAttachments')
        .get();

      const emails = (response.value || []).map((e) => {
        const headers = {};
        for (const h of e.internetMessageHeaders || []) {
          headers[String(h.name || '').toLowerCase()] = h.value;
        }
        return {
          id: e.id,
          subject: e.subject || '',
          from: e.from?.emailAddress?.address || '',
          fromName: e.from?.emailAddress?.name || '',
          to: (e.toRecipients || []).map((r) => r.emailAddress?.address).filter(Boolean),
          cc: (e.ccRecipients || []).map((r) => r.emailAddress?.address).filter(Boolean),
          receivedAt: new Date(e.receivedDateTime),
          bodyPreview: e.bodyPreview || '',
          bodyHtml: e.body?.contentType === 'html' ? e.body?.content : null,
          bodyText: e.body?.contentType === 'text' ? e.body?.content : null,
          conversationId: e.conversationId,
          internetMessageId: e.internetMessageId || null,
          hasAttachments: e.hasAttachments === true,
          inReplyTo: headers['in-reply-to'] || null,
          references: headers.references || null,
          autoSubmitted: headers['auto-submitted'] || null,
          precedence: headers.precedence || null,
        };
      });
      return emails.reverse(); // oldest first
    } catch (error) {
      logger.error('Graph API: failed to fetch messages for ingest', {
        mailbox, error: error.message, code: error.code,
      });
      throw error;
    }
  }

  /**
   * File attachments for a message (base64 content). Item/reference
   * attachments are skipped; oversized files are reported but not fetched.
   */
  async getMessageAttachments(mailbox, messageId, { maxBytes = 25 * 1024 * 1024 } = {}) {
    const client = this._getClient();
    try {
      const response = await client
        .api(`/users/${mailbox}/messages/${messageId}/attachments`)
        .get();
      const all = response.value || [];
      const files = [];
      const skipped = [];
      for (const a of all) {
        const isFile = a['@odata.type'] === '#microsoft.graph.fileAttachment' && a.contentBytes;
        if (!isFile) { skipped.push({ name: a.name, reason: 'not_a_file' }); continue; }
        if ((a.size || 0) > maxBytes) { skipped.push({ name: a.name, reason: 'too_large' }); continue; }
        files.push({
          name: a.name || 'attachment',
          contentType: a.contentType || 'application/octet-stream',
          sizeBytes: a.size || 0,
          buffer: Buffer.from(a.contentBytes, 'base64'),
        });
      }
      return { files, skipped };
    } catch (error) {
      logger.warn('Graph API: failed to fetch message attachments', {
        mailbox, messageId, error: error.message,
      });
      return { files: [], skipped: [], error: error.message };
    }
  }

  /**
   * Send mail FROM a mailbox via draft-then-send, which (unlike /sendMail)
   * lets us capture the internetMessageId for reply threading.
   * Requires Mail.Send application permission.
   */
  async sendMailAsMailbox(mailbox, { to, cc = [], subject, html, attachments = [], fromName = null }) {
    const client = this._getClient();
    const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean)
      .map((address) => ({ emailAddress: { address } }));
    if (recipients.length === 0) throw new Error('Email recipient is required');

    const draftPayload = {
      subject,
      body: { contentType: 'HTML', content: html },
      toRecipients: recipients,
      ccRecipients: cc.filter(Boolean).map((address) => ({ emailAddress: { address } })),
    };
    // Best-effort sender display name (Phase EB). Graph sends AS the
    // mailbox, and Exchange typically rewrites arbitrary from-names to the
    // directory displayName on delivery — so this is cosmetic-at-best and
    // harmless when rewritten. Per-workspace names are only guaranteed on
    // the SendGrid path; the durable Graph-side fix is renaming the mailbox
    // (e.g. ticketpulse@ -> "Ticket Pulse") in Entra/Exchange.
    const name = String(fromName || '').trim();
    if (name) {
      draftPayload.from = { emailAddress: { address: mailbox, name } };
    }
    const draft = await client.api(`/users/${mailbox}/messages`).post(draftPayload);

    // Simple file attach caps at ~3 MB per request; larger files need upload
    // sessions, so callers pre-filter (oversized ones stay stored in Ticket Pulse).
    for (const file of attachments) {
      if (!file?.contentBytes) continue;
      try {
        await client.api(`/users/${mailbox}/messages/${draft.id}/attachments`).post({
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: file.name || 'attachment',
          contentType: file.contentType || 'application/octet-stream',
          contentBytes: file.contentBytes,
        });
      } catch (error) {
        logger.warn('Graph API: attachment failed to attach to outbound mail (send continues)', {
          mailbox, name: file.name, error: error.message,
        });
      }
    }

    await client.api(`/users/${mailbox}/messages/${draft.id}/send`).post({});

    logger.info('Graph API: mail sent', { mailbox, to: recipients.map((r) => r.emailAddress.address), subject });
    return {
      messageId: draft.id,
      internetMessageId: draft.internetMessageId || null,
      conversationId: draft.conversationId || null,
    };
  }

  /**
   * Test connectivity to a specific mailbox.
   * @param {string} mailbox - Email address to test
   * @returns {Promise<{success: boolean, message: string, recentCount: number}>}
   */
  async testConnection(mailbox) {
    try {
      const client = this._getClient();
      const response = await client
        .api(`/users/${mailbox}/mailFolders/inbox/messages`)
        .top(1)
        .select('id,subject,receivedDateTime')
        .get();

      const count = response['@odata.count'] || response.value?.length || 0;
      const latest = response.value?.[0];

      return {
        success: true,
        message: `Connected successfully to ${mailbox}`,
        recentCount: count,
        latestSubject: latest?.subject,
        latestReceivedAt: latest?.receivedDateTime,
      };
    } catch (error) {
      const msg = error.body ? (() => { try { return JSON.parse(error.body)?.error?.message; } catch { return null; } })() : null;
      const code = error.code || error.statusCode;
      logger.error('Graph API testConnection failed', { mailbox, error: msg || error.message, code });
      return {
        success: false,
        message: msg || error.message || 'Connection failed',
        code,
      };
    }
  }
  /**
   * Fetch user profile from Azure AD by email.
   * Requires User.Read.All application permission.
   */
  async getUserProfile(email) {
    if (!this.isConfigured()) {
      return { error: 'Azure Graph API not configured' };
    }

    try {
      const client = this._getClient();
      const user = await client
        .api(`/users/${email}`)
        .select('id,displayName,jobTitle,department,officeLocation,mail,employeeType,employeeId,companyName,city,state,country,usageLocation,preferredLanguage,businessPhones,mobilePhone')
        .get();

      return {
        success: true,
        displayName: user.displayName,
        email: user.mail,
        jobTitle: user.jobTitle,
        department: user.department,
        officeLocation: user.officeLocation,
        companyName: user.companyName,
        city: user.city,
        state: user.state,
        country: user.country,
        usageLocation: user.usageLocation,
        preferredLanguage: user.preferredLanguage,
        businessPhones: user.businessPhones || [],
        mobilePhone: user.mobilePhone || null,
        employeeType: user.employeeType,
        employeeId: user.employeeId,
      };
    } catch (error) {
      const msg = error.body ? (() => { try { return JSON.parse(error.body)?.error?.message; } catch { return null; } })() : null;
      const code = error.code || error.statusCode;

      if (code === 'Authorization_RequestDenied' || code === 403) {
        logger.warn('Graph API getUserProfile: User.Read.All permission not granted', { email });
        return { error: 'User.Read.All permission not granted on the Azure AD app registration. An admin needs to add this permission and grant admin consent.' };
      }

      logger.error('Graph API getUserProfile failed', { email, error: msg || error.message, code });
      return { error: msg || error.message || 'Failed to fetch user profile' };
    }
  }

  /**
   * Search users by name prefix. Useful for finding users when only a name is known.
   */
  async searchUsers(nameQuery, top = 5) {
    if (!this.isConfigured()) {
      return { error: 'Azure Graph API not configured' };
    }

    try {
      const client = this._getClient();
      const response = await client
        .api('/users')
        .filter(`startsWith(displayName,'${nameQuery.replace(/'/g, "''")}')`)
        .top(top)
        .select('id,displayName,jobTitle,department,mail,employeeType,employeeId')
        .get();

      return {
        success: true,
        users: (response.value || []).map((u) => ({
          displayName: u.displayName,
          email: u.mail,
          jobTitle: u.jobTitle,
          department: u.department,
          employeeType: u.employeeType,
          employeeId: u.employeeId,
        })),
      };
    } catch (error) {
      const code = error.code || error.statusCode;
      if (code === 'Authorization_RequestDenied' || code === 403) {
        return { error: 'User.Read.All permission not granted' };
      }
      logger.error('Graph API searchUsers failed', { nameQuery, error: error.message });
      return { error: error.message || 'Search failed' };
    }
  }
}

export default new GraphMailClient();
