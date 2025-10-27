import axios from 'axios';
import logger from '../utils/logger.js';

/**
 * Azure AD (Entra ID) Service
 * Handles authentication and fetching user profile photos from Microsoft Graph API
 */
class AzureAdService {
  constructor() {
    this.clientId = process.env.AZURE_AD_CLIENT_ID;
    this.clientSecret = process.env.AZURE_AD_CLIENT_SECRET;
    this.tenantId = process.env.AZURE_AD_TENANT_ID;
    this.graphApiUrl = 'https://graph.microsoft.com/v1.0';
    this.accessToken = null;
    this.tokenExpiry = null;
  }

  /**
   * Get access token using client credentials flow
   * @returns {Promise<string>} Access token
   */
  async getAccessToken() {
    // Return cached token if still valid
    if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    try {
      const tokenUrl = `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`;

      const params = new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials',
      });

      const response = await axios.post(tokenUrl, params, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });

      this.accessToken = response.data.access_token;
      // Set expiry to 5 minutes before actual expiry for safety
      this.tokenExpiry = Date.now() + ((response.data.expires_in - 300) * 1000);

      logger.info('Azure AD access token obtained successfully');
      return this.accessToken;
    } catch (error) {
      logger.error('Failed to get Azure AD access token', {
        error: error.message,
        response: error.response?.data,
      });
      throw new Error(`Azure AD authentication failed: ${error.message}`);
    }
  }

  /**
   * Get user photo from Azure AD by email
   * @param {string} email - User email address
   * @returns {Promise<string|null>} Base64 encoded photo or null if not found
   */
  async getUserPhoto(email) {
    if (!email) {
      logger.warn('No email provided for photo fetch');
      return null;
    }

    try {
      const token = await this.getAccessToken();

      // Get user photo
      const photoUrl = `${this.graphApiUrl}/users/${encodeURIComponent(email)}/photo/$value`;

      const response = await axios.get(photoUrl, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
        responseType: 'arraybuffer',
      });

      // Convert to base64
      const base64 = Buffer.from(response.data, 'binary').toString('base64');
      const contentType = response.headers['content-type'] || 'image/jpeg';

      logger.info(`Photo fetched successfully for ${email}`);
      return `data:${contentType};base64,${base64}`;
    } catch (error) {
      if (error.response?.status === 404) {
        logger.info(`No photo found for ${email}`);
        return null;
      }

      logger.error(`Failed to fetch photo for ${email}`, {
        error: error.message,
        status: error.response?.status,
      });
      return null;
    }
  }

  /**
   * Get photos for multiple users
   * @param {Array<{email: string, id: number}>} users - Array of user objects with email and id
   * @param {number} concurrency - Number of parallel requests (default: 3)
   * @returns {Promise<Array<{id: number, email: string, photoUrl: string|null}>>}
   */
  async getUserPhotos(users, concurrency = 3) {
    const results = [];

    for (let i = 0; i < users.length; i += concurrency) {
      const batch = users.slice(i, i + concurrency);

      const batchPromises = batch.map(async (user) => {
        try {
          const photoUrl = await this.getUserPhoto(user.email);
          return {
            id: user.id,
            email: user.email,
            photoUrl,
          };
        } catch (error) {
          logger.error(`Error fetching photo for user ${user.email}`, { error: error.message });
          return {
            id: user.id,
            email: user.email,
            photoUrl: null,
          };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);

      // Small delay between batches to avoid rate limiting
      if (i + concurrency < users.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    return results;
  }

  /**
   * Check if Azure AD is configured
   * @returns {boolean}
   */
  isConfigured() {
    return !!(this.clientId && this.clientSecret && this.tenantId);
  }
}

export default new AzureAdService();
