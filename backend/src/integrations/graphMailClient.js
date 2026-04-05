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
        .select('id,displayName,jobTitle,department,officeLocation,mail,employeeType,employeeId,companyName,city,state,country')
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
