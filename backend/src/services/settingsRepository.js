import { PrismaClient } from '@prisma/client';
import logger from '../utils/logger.js';
import { DatabaseError, NotFoundError } from '../utils/errors.js';

const prisma = new PrismaClient();

/**
 * Default settings values
 */
const DEFAULT_SETTINGS = {
  freshservice_domain: '',
  freshservice_api_key: '',
  sync_interval_minutes: 5,
  default_timezone: 'America/Los_Angeles',
  dashboard_refresh_seconds: 30,
};

/**
 * Repository for AppSettings operations
 */
class SettingsRepository {
  /**
   * Get a specific setting by key
   * @param {string} key - Setting key
   * @returns {Promise<string|number|null>} Setting value
   */
  async get(key) {
    try {
      const setting = await prisma.appSettings.findUnique({
        where: { key },
      });

      if (!setting) {
        // Return default value if available
        return DEFAULT_SETTINGS[key] !== undefined ? DEFAULT_SETTINGS[key] : null;
      }

      return setting.value;
    } catch (error) {
      logger.error(`Error fetching setting ${key}:`, error);
      throw new DatabaseError(`Failed to fetch setting ${key}`, error);
    }
  }

  /**
   * Set a specific setting
   * @param {string} key - Setting key
   * @param {string|number} value - Setting value
   * @returns {Promise<Object>} Updated or created setting
   */
  async set(key, value) {
    try {
      return await prisma.appSettings.upsert({
        where: { key },
        update: {
          value: String(value),
          updatedAt: new Date(),
        },
        create: {
          key,
          value: String(value),
        },
      });
    } catch (error) {
      logger.error(`Error setting ${key}:`, error);
      throw new DatabaseError(`Failed to set ${key}`, error);
    }
  }

  /**
   * Get all settings as a key-value object
   * @returns {Promise<Object>} All settings
   */
  async getAll() {
    try {
      const settings = await prisma.appSettings.findMany();

      // Start with defaults
      const result = { ...DEFAULT_SETTINGS };

      // Override with database values
      settings.forEach(setting => {
        result[setting.key] = setting.value;
      });

      return result;
    } catch (error) {
      logger.error('Error fetching all settings:', error);
      throw new DatabaseError('Failed to fetch all settings', error);
    }
  }

  /**
   * Update multiple settings at once
   * @param {Object} settings - Key-value pairs of settings to update
   * @returns {Promise<number>} Number of settings updated
   */
  async setMany(settings) {
    try {
      const operations = Object.entries(settings).map(([key, value]) =>
        prisma.appSettings.upsert({
          where: { key },
          update: {
            value: String(value),
            updatedAt: new Date(),
          },
          create: {
            key,
            value: String(value),
          },
        }),
      );

      await Promise.all(operations);
      logger.info(`Updated ${operations.length} settings`);
      return operations.length;
    } catch (error) {
      logger.error('Error updating multiple settings:', error);
      throw new DatabaseError('Failed to update multiple settings', error);
    }
  }

  /**
   * Delete a specific setting
   * @param {string} key - Setting key
   * @returns {Promise<boolean>} True if deleted, false if not found
   */
  async delete(key) {
    try {
      await prisma.appSettings.delete({
        where: { key },
      });
      logger.info(`Deleted setting: ${key}`);
      return true;
    } catch (error) {
      if (error.code === 'P2025') {
        return false; // Setting not found
      }
      logger.error(`Error deleting setting ${key}:`, error);
      throw new DatabaseError(`Failed to delete setting ${key}`, error);
    }
  }

  /**
   * Initialize default settings if they don't exist
   * @returns {Promise<number>} Number of settings initialized
   */
  async initializeDefaults() {
    try {
      const operations = Object.entries(DEFAULT_SETTINGS).map(([key, value]) =>
        prisma.appSettings.upsert({
          where: { key },
          update: {}, // Don't update if exists
          create: {
            key,
            value: String(value),
          },
        }),
      );

      await Promise.all(operations);
      logger.info('Default settings initialized');
      return operations.length;
    } catch (error) {
      logger.error('Error initializing default settings:', error);
      throw new DatabaseError('Failed to initialize default settings', error);
    }
  }

  /**
   * Check if FreshService is configured
   * @returns {Promise<boolean>} True if configured
   */
  async isFreshServiceConfigured() {
    try {
      const domain = await this.get('freshservice_domain');
      const apiKey = await this.get('freshservice_api_key');

      return Boolean(domain && apiKey);
    } catch (error) {
      logger.error('Error checking FreshService configuration:', error);
      return false;
    }
  }

  /**
   * Get FreshService configuration
   * @returns {Promise<Object>} FreshService config
   */
  async getFreshServiceConfig() {
    try {
      const [domain, apiKey, workspaceId] = await Promise.all([
        this.get('freshservice_domain'),
        this.get('freshservice_api_key'),
        this.get('freshservice_workspace_id'),
      ]);

      if (!domain || !apiKey) {
        throw new NotFoundError('FreshService configuration not found');
      }

      return {
        domain,
        apiKey,
        workspaceId: workspaceId || null,
      };
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw error;
      }
      logger.error('Error fetching FreshService config:', error);
      throw new DatabaseError('Failed to fetch FreshService configuration', error);
    }
  }

  /**
   * Get sync configuration
   * @returns {Promise<Object>} Sync config
   */
  async getSyncConfig() {
    try {
      const [intervalMinutes, defaultTimezone] = await Promise.all([
        this.get('sync_interval_minutes'),
        this.get('default_timezone'),
      ]);

      return {
        intervalMinutes: Number(intervalMinutes),
        defaultTimezone: String(defaultTimezone),
      };
    } catch (error) {
      logger.error('Error fetching sync config:', error);
      throw new DatabaseError('Failed to fetch sync configuration', error);
    }
  }
}

export default new SettingsRepository();
