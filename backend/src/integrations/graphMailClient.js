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
    this._credential = credential;
    const authProvider = new TokenCredentialAuthenticationProvider(credential, {
      scopes: ['https://graph.microsoft.com/.default'],
    });

    this._client = Client.initWithMiddleware({ authProvider });
    return this._client;
  }

  /**
   * Application roles granted to the app registration (Phase RL, RL-7):
   * decoded from the `roles` claim of the client-credentials token — the
   * same token every Graph call rides, so this is exactly what Exchange
   * will enforce. Null when the token cannot be fetched/decoded (the caller
   * treats that as "unknown", never as "granted").
   */
  async getAppRoles() {
    try {
      this._getClient();
      const credential = this._credential;
      if (!credential || typeof credential.getToken !== 'function') return null;
      const token = await credential.getToken('https://graph.microsoft.com/.default');
      return decodeTokenRoles(token?.token);
    } catch (error) {
      logger.debug('Graph API: app role decode failed', { error: error.message });
      return null;
    }
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
        .select(INGEST_MESSAGE_SELECT)
        .get();

      // Same projection + mapper as the webhook/delta lanes (MB-2): one
      // place defines what an ingested email looks like.
      const emails = (response.value || []).map(mapGraphMessageForIngest);
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
   * Resolve a stored RFC Message-ID to the Graph item id of that message in
   * the mailbox (any folder — Inbox for requester mail, Sent Items for our own
   * outbound). `/users/{mb}/messages` spans the whole mailbox; the odata
   * string literal escapes single quotes by doubling them. Null when the
   * message isn't there (purged, sent via SendGrid, another mailbox) or the
   * lookup fails — callers fall back to an unthreaded draft.
   */
  async _findMessageIdByInternetMessageId(client, mailbox, internetMessageId) {
    const id = String(internetMessageId || '').trim();
    if (!id) return null;
    try {
      const response = await client
        .api(`/users/${mailbox}/messages`)
        .filter(`internetMessageId eq '${id.replace(/'/g, "''")}'`)
        .select('id')
        .top(1)
        .get();
      return response?.value?.[0]?.id || null;
    } catch (error) {
      logger.debug('Graph API: Message-ID lookup failed (reply will not be header-threaded)', {
        mailbox, internetMessageId: id, error: error.message,
      });
      return null;
    }
  }

  /**
   * Send mail FROM a mailbox. Anchored replies go draft-then-send via
   * createReply (needs Mail.ReadWrite — Exchange writes the threading
   * headers); everything else goes through /sendMail with a minted
   * Message-ID (Mail.Send only — Phase RL, RL-2).
   *
   * Threading (MB-1b) — WHY createReply and not internetMessageHeaders:
   * Graph only accepts CUSTOM headers on message creation, and they must be
   * named `x-`/`X-` (message resource doc: "Add custom headers only when
   * creating a message, and name them starting with 'x-'"). Posting
   * `In-Reply-To` / `References` through `internetMessageHeaders` is
   * rejected (InvalidInternetMessageHeader) — there is no JSON path that
   * sets the standard threading headers directly. The supported way is to
   * let Exchange do it: `POST /users/{mb}/messages/{id}/createReply` on the
   * message we are answering produces a draft that already carries
   * In-Reply-To + References (+ Thread-Index/conversationIndex, which is
   * what Outlook's conversation view keys on; Gmail keys on References +
   * subject). Per the createReply doc the draft can then be UPDATED (subject,
   * body, recipients, replyTo) before /send — so we overwrite everything the
   * reply pre-fills and keep the headers. The anchor is resolved from the
   * caller's RFC Message-ID (`inReplyTo`, else the newest `references`)
   * through a `$filter=internetMessageId eq` lookup across the mailbox
   * (Inbox for requester mail, Sent Items for our own earlier sends). When no
   * anchor resolves (SendGrid-era ids, purged mail) we fall back to the
   * plain draft — the `[TP-n]` subject token and the plus-addressed
   * Reply-To remain as the inbound matching signals.
   *
   * @param {string} mailbox
   * @param {object} opts
   * @param {string|string[]} opts.to
   * @param {string[]} [opts.cc]
   * @param {string} opts.subject
   * @param {string} opts.html
   * @param {Array<{name,contentType,contentBytes}>} [opts.attachments]
   * @param {string|null} [opts.fromName]
   * @param {string|null} [opts.replyTo]     - Reply-To address (e.g. `mailbox+tp<n>@domain`)
   * @param {string|null} [opts.inReplyTo]   - RFC Message-ID (with angle brackets) being answered
   * @param {string[]}    [opts.references]  - RFC Message-ID chain, oldest first (may be empty)
   * @returns {{messageId, internetMessageId, conversationId, threadedVia: 'createReply'|null}}
   */
  async sendMailAsMailbox(mailbox, {
    to, cc = [], subject, html, attachments = [], fromName = null,
    replyTo = null, inReplyTo = null, references = [],
  }) {
    const client = this._getClient();
    const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean)
      .map((address) => ({ emailAddress: { address } }));
    if (recipients.length === 0) throw new Error('Email recipient is required');

    const draftPayload = {
      subject,
      body: { contentType: 'HTML', content: html },
      toRecipients: recipients,
      ccRecipients: (Array.isArray(cc) ? cc : []).filter(Boolean).map((address) => ({ emailAddress: { address } })),
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
    // Reply-To (MB-1c): the plus-addressed ticket token the caller computed
    // (`patickets+tp1042@…`). Exchange Online delivers plus addresses to the
    // base mailbox; ingest rung 1.5 reads the tag back off To/Delivered-To.
    const replyToAddress = String(replyTo || '').trim();
    if (replyToAddress) {
      draftPayload.replyTo = [{ emailAddress: { address: replyToAddress } }];
    }

    // Threading anchor: In-Reply-To first, then the References chain newest
    // first (bounded — each miss costs a Graph round trip).
    const anchors = [...new Set([
      inReplyTo,
      ...[...(Array.isArray(references) ? references : [])].reverse(),
    ].map((v) => String(v || '').trim()).filter(Boolean))].slice(0, 3);

    let draft = null;
    let threadedVia = null;
    for (const anchor of anchors) {
      const anchorId = await this._findMessageIdByInternetMessageId(client, mailbox, anchor);
      if (!anchorId) continue;
      try {
        const replyDraft = await client.api(`/users/${mailbox}/messages/${anchorId}/createReply`).post({});
        // createReply pre-fills subject ("RE: …"), the quoted body and the
        // original sender as To — overwrite all of it with ours; Exchange
        // keeps In-Reply-To/References/Thread-Index on the item.
        const updated = await client.api(`/users/${mailbox}/messages/${replyDraft.id}`).patch(draftPayload);
        draft = { ...replyDraft, ...(updated && typeof updated === 'object' ? updated : {}), id: replyDraft.id };
        threadedVia = 'createReply';
        break;
      } catch (error) {
        const status = graphErrorStatus(error);
        logger.warn(status === 403
          ? 'Graph API: createReply refused (403 — Mail.ReadWrite not granted), falling back to sendMail without header threading'
          : 'Graph API: createReply threading failed, falling back to sendMail', {
          mailbox, anchor, status, error: error.message,
        });
        draft = null;
      }
    }
    if (!draft) {
      // No anchor (fresh ack, SendGrid-era ids, purged mail) or createReply
      // refused (Phase RL, RL-2 — Mail.ReadWrite not granted): send in one
      // call through `POST /users/{mb}/sendMail`, which needs Mail.Send ONLY.
      // The draft-then-send path this replaces needed ReadWrite just to park
      // the draft, so with a Mail.Send-only grant every send 403'd and fell
      // back to SendGrid as ticketpulse@. We mint the RFC Message-ID
      // ourselves (Graph honours a caller-supplied internetMessageId) so
      // ingest rung 1 still threads the reply; the `[TP-n]` subject token
      // and the plus-addressed Reply-To remain as backup signals.
      const internetMessageId = mintInternetMessageId(mailbox);
      const inlineAttachments = attachments
        .filter((file) => file?.contentBytes)
        .map((file) => ({
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: file.name || 'attachment',
          contentType: file.contentType || 'application/octet-stream',
          contentBytes: file.contentBytes,
        }));
      try {
        await client.api(`/users/${mailbox}/sendMail`).post({
          message: {
            ...draftPayload,
            internetMessageId,
            ...(inlineAttachments.length ? { attachments: inlineAttachments } : {}),
          },
          saveToSentItems: true,
        });
      } catch (error) {
        throw tagGraphSendError(error, mailbox, 'sendMail');
      }
      logger.info('Graph API: mail sent', {
        mailbox, to: recipients.map((r) => r.emailAddress.address), subject, threadedVia: null, sentVia: 'sendMail', replyTo: replyToAddress || null,
      });
      return {
        messageId: null,
        internetMessageId,
        conversationId: null,
        threadedVia: null,
        sentVia: 'sendMail',
      };
    }

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

    try {
      await client.api(`/users/${mailbox}/messages/${draft.id}/send`).post({});
    } catch (error) {
      throw tagGraphSendError(error, mailbox, 'send');
    }

    logger.info('Graph API: mail sent', {
      mailbox, to: recipients.map((r) => r.emailAddress.address), subject, threadedVia, sentVia: 'draft', replyTo: replyToAddress || null,
    });
    return {
      messageId: draft.id,
      internetMessageId: draft.internetMessageId || null,
      conversationId: draft.conversationId || null,
      threadedVia,
      sentVia: 'draft',
    };
  }

  /**
   * Test connectivity to a specific mailbox.
   * @param {string} mailbox - Email address to test
   * @returns {Promise<{success: boolean, message: string, recentCount: number}>}
   */
  async testConnection(mailbox, { mode = 'both' } = {}) {
    // Phase RL (RL-7): the test proves READ *and* SEND capability. Reading
    // the inbox exercises Mail.Read against this mailbox; the app token's
    // roles decide whether sends (Mail.Send) and header-threaded replies
    // (Mail.ReadWrite → createReply) can work. `null` = could not tell.
    const roles = await this.getAppRoles();
    const caps = capabilitiesFromRoles(roles);
    const wantsSend = ['send', 'both'].includes(mode);
    try {
      const client = this._getClient();
      const response = await client
        .api(`/users/${mailbox}/mailFolders/inbox/messages`)
        .top(1)
        .select('id,subject,receivedDateTime')
        .get();

      const count = response['@odata.count'] || response.value?.length || 0;
      const latest = response.value?.[0];
      const canRead = true;
      const sendProblem = wantsSend && caps.canSend === false;
      const threadProblem = wantsSend && caps.canThread === false;
      const message = sendProblem
        ? `Connected to ${mailbox}, but the app cannot SEND from it — Mail.Send is not granted`
        : threadProblem
          ? `Connected to ${mailbox}; sends work but replies cannot be header-threaded — Mail.ReadWrite is not granted`
          : `Connected successfully to ${mailbox}`;

      return {
        success: !sendProblem,
        message,
        recentCount: count,
        latestSubject: latest?.subject,
        latestReceivedAt: latest?.receivedDateTime,
        canRead,
        canSend: caps.canSend,
        canThread: caps.canThread,
        roles,
        mode,
      };
    } catch (error) {
      const msg = error.body ? (() => { try { return JSON.parse(error.body)?.error?.message; } catch { return null; } })() : null;
      const code = error.code || error.statusCode;
      logger.error('Graph API testConnection failed', { mailbox, error: msg || error.message, code });
      return {
        success: false,
        message: msg || error.message || 'Connection failed',
        code,
        canRead: false,
        canSend: caps.canSend,
        canThread: caps.canThread,
        roles,
        mode,
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

  // ---------------------------------------------------------------------
  // Change notifications + delta (Mega 08-31 Phase MB-2). Additive helpers;
  // the subscription manager (services/graphSubscriptionService.js) and the
  // poller (services/mailboxIngestService.js) are the only callers.
  // ---------------------------------------------------------------------

  /**
   * One message by Graph id, in the ingest projection (same $select as the
   * poller — perf-lane rule: never pull more than the pipeline reads). Null
   * when the message is gone (404: deleted/moved before we got to it).
   */
  async getMessageForIngest(mailbox, messageId) {
    const client = this._getClient();
    try {
      const e = await client
        .api(`/users/${mailbox}/messages/${encodeURIComponent(messageId)}`)
        .select(INGEST_MESSAGE_SELECT)
        .get();
      return e ? mapGraphMessageForIngest(e) : null;
    } catch (error) {
      if (graphErrorStatus(error) === 404) return null;
      logger.warn('Graph API: failed to fetch message by id for ingest', {
        mailbox, messageId, error: error.message, code: error.code,
      });
      throw error;
    }
  }

  /**
   * Inbox delta round: follows @odata.nextLink pages until @odata.deltaLink.
   * `deltaLink` null = bootstrap round, filtered to receivedDateTime ge
   * `since` (the ONLY $filter delta supports; it must be on the initial
   * request and is baked into the returned token from then on). The
   * projection is deliberately tiny — the caller re-fetches changed messages
   * by id through getMessageForIngest so every lane shares one mapper.
   *
   * Delta emits collection-level events that don't match the filter
   * (read/unread flips, `@removed` on delete/move) — callers skip `removed`
   * and dedupe the rest by internetMessageId before fetching.
   *
   * Throws with `error.deltaReset = true` when Graph says the token is dead
   * (410 Gone / syncStateNotFound) so the caller can clear it and bootstrap.
   */
  async getInboxDeltaChanges(mailbox, deltaLink = null, { since = null, maxPages = 20, pageSize = 50 } = {}) {
    const client = this._getClient();
    const items = [];
    const url = deltaLink || null;
    let pages = 0;
    try {
      let response;
      if (!url) {
        let request = client
          .api(`/users/${mailbox}/mailFolders/inbox/messages/delta`)
          .select('id,receivedDateTime,internetMessageId')
          .header('Prefer', `odata.maxpagesize=${pageSize}`);
        if (since instanceof Date && !Number.isNaN(since.getTime())) {
          request = request.filter(`receivedDateTime ge ${since.toISOString()}`);
        }
        response = await request.get();
      } else {
        response = await client.api(url).header('Prefer', `odata.maxpagesize=${pageSize}`).get();
      }
      for (;;) {
        pages += 1;
        for (const e of response?.value || []) {
          items.push({
            id: e.id,
            removed: Boolean(e['@removed']),
            receivedAt: e.receivedDateTime ? new Date(e.receivedDateTime) : null,
            internetMessageId: e.internetMessageId || null,
          });
        }
        const next = response?.['@odata.nextLink'];
        const done = response?.['@odata.deltaLink'];
        if (done || !next || pages >= maxPages) {
          // Page cap hit without a deltaLink: keep the nextLink as the cursor;
          // the next round resumes from it (Graph accepts either token form).
          return { items, deltaLink: done || next || url || null, truncated: !done && Boolean(next) };
        }
        response = await client.api(next).header('Prefer', `odata.maxpagesize=${pageSize}`).get();
      }
    } catch (error) {
      const status = graphErrorStatus(error);
      const code = String(error.code || '');
      if (status === 410 || /syncStateNotFound|resyncRequired|SyncStateInvalid/i.test(code)) {
        error.deltaReset = true;
      }
      logger.warn('Graph API: inbox delta round failed', {
        mailbox, bootstrap: !deltaLink, error: error.message, code: error.code, status,
      });
      throw error;
    }
  }

  /**
   * Create a `created` change-notification subscription on the mailbox's
   * inbox. lifecycleNotificationUrl MUST be set here — Graph refuses to add
   * it on PATCH later (delete + recreate is the only path).
   */
  async createMailSubscription(mailbox, { notificationUrl, lifecycleNotificationUrl, clientState, expirationDateTime }) {
    const client = this._getClient();
    const body = {
      changeType: 'created',
      notificationUrl,
      lifecycleNotificationUrl,
      resource: `/users/${mailbox}/mailFolders('inbox')/messages`,
      expirationDateTime: new Date(expirationDateTime).toISOString(),
      clientState,
      latestSupportedTlsVersion: 'v1_2',
    };
    try {
      const created = await client.api('/subscriptions').post(body);
      logger.info('Graph API: mail subscription created', {
        mailbox, subscriptionId: created?.id, expiresAt: created?.expirationDateTime,
      });
      return { id: created?.id || null, expirationDateTime: created?.expirationDateTime || body.expirationDateTime };
    } catch (error) {
      logger.warn('Graph API: mail subscription create failed', {
        mailbox, error: graphErrorMessage(error), code: error.code, status: graphErrorStatus(error),
      });
      throw error;
    }
  }

  /**
   * Renew (PATCH expirationDateTime). Per the lifecycle doc a single PATCH
   * both renews AND reauthorizes, and must not be combined with /reauthorize
   * inside a 10-minute window — so the manager answers reauthorizationRequired
   * with this call rather than the reauthorize action.
   */
  async renewSubscription(subscriptionId, expirationDateTime) {
    const client = this._getClient();
    try {
      const updated = await client
        .api(`/subscriptions/${encodeURIComponent(subscriptionId)}`)
        .patch({ expirationDateTime: new Date(expirationDateTime).toISOString() });
      return {
        id: updated?.id || subscriptionId,
        expirationDateTime: updated?.expirationDateTime || new Date(expirationDateTime).toISOString(),
      };
    } catch (error) {
      logger.warn('Graph API: subscription renew failed', {
        subscriptionId, error: graphErrorMessage(error), code: error.code, status: graphErrorStatus(error),
      });
      throw error;
    }
  }

  /** Reauthorize without extending expiry (kept for completeness). */
  async reauthorizeSubscription(subscriptionId) {
    const client = this._getClient();
    await client.api(`/subscriptions/${encodeURIComponent(subscriptionId)}/reauthorize`).post({});
    return { id: subscriptionId };
  }

  /** Delete; a 404 (already gone) is success. */
  async deleteSubscription(subscriptionId) {
    const client = this._getClient();
    try {
      await client.api(`/subscriptions/${encodeURIComponent(subscriptionId)}`).delete();
      return { deleted: true };
    } catch (error) {
      if (graphErrorStatus(error) === 404) return { deleted: false, missing: true };
      logger.warn('Graph API: subscription delete failed', {
        subscriptionId, error: graphErrorMessage(error), code: error.code, status: graphErrorStatus(error),
      });
      throw error;
    }
  }
}

/** Ingest projection shared by the poller, the delta lane and the webhook worker. */
export const INGEST_MESSAGE_SELECT = 'id,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,body,conversationId,internetMessageId,internetMessageHeaders,hasAttachments';

/** Graph message → the flat email shape mailboxIngestService consumes. */
export function mapGraphMessageForIngest(e) {
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
    // Envelope-recipient headers (MB-1c): a reply to our plus-addressed
    // Reply-To (`mailbox+tp<n>@`) normally shows in toRecipients, but
    // forwarding/relay hops keep the original in these instead.
    deliveredTo: headers['delivered-to'] || null,
    xOriginalTo: headers['x-original-to'] || null,
  };
}

/**
 * Mint an RFC 5322 Message-ID for a sendMail send (Phase RL, RL-2):
 * `<tp-<epoch>-<random>@<mailbox domain>>` — stored on the thread entry /
 * delivery so ingest rung 1 recognises the requester's reply.
 */
export function mintInternetMessageId(mailbox) {
  const domain = String(mailbox || '').split('@')[1] || 'ticketpulse.local';
  const rand = Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 8);
  return `<tp-${Date.now()}-${rand}@${domain}>`;
}

/** Decode the `roles` claim of a JWT (no signature check — informational). */
export function decodeTokenRoles(jwt) {
  const parts = String(jwt || '').split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    const roles = Array.isArray(payload?.roles) ? payload.roles.map(String) : [];
    return roles;
  } catch {
    return null;
  }
}

/**
 * What the granted application roles allow (Phase RL, RL-7). Nulls when
 * the roles are unknown — the panel shows "could not verify", not a tick.
 *   canRead   — Mail.Read or Mail.ReadWrite (inbox ingest, anchor lookups)
 *   canSend   — Mail.Send (sendMail; draft /send too)
 *   canThread — Mail.ReadWrite (createReply drafts → In-Reply-To/References)
 */
export function capabilitiesFromRoles(roles) {
  if (!Array.isArray(roles)) return { canRead: null, canSend: null, canThread: null };
  const set = new Set(roles.map((r) => String(r)));
  const readWrite = set.has('Mail.ReadWrite');
  return {
    canRead: set.has('Mail.Read') || readWrite,
    canSend: set.has('Mail.Send'),
    canThread: readWrite,
  };
}

/**
 * Tag a Graph send failure so the health telemetry classifies it correctly
 * (Phase RL, RL-2): a 403 on sendMail / send / createReply is a missing
 * application permission, never an IP block.
 */
function tagGraphSendError(error, mailbox, operation) {
  const status = graphErrorStatus(error);
  if (status === 403 || String(error?.code || '').toLowerCase() === 'erroraccessdenied') {
    error.graphPermissionDenied = true;
    error.errorClass = 'permission_denied';
    error.graphOperation = operation;
    error.message = `Microsoft Graph ${operation} as ${mailbox} was refused (403 access denied): ${graphErrorMessage(error)}`;
  }
  return error;
}

/** HTTP status of a microsoft-graph-client error (GraphError.statusCode), if any. */
export function graphErrorStatus(error) {
  const raw = error?.statusCode ?? (typeof error?.code === 'number' ? error.code : null);
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function graphErrorMessage(error) {
  if (error?.body) {
    try { return JSON.parse(error.body)?.error?.message || error.message; } catch { /* fall through */ }
  }
  return error?.message || String(error);
}

export default new GraphMailClient();
