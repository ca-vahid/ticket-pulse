import nodemailer from 'nodemailer';
import config from '../config/index.js';
import logger from '../utils/logger.js';

/**
 * Email Service
 * Handles sending auto-response emails
 */
class EmailService {
  constructor() {
    this.transporter = null;
    this.isConfigured = false;

    if (config.smtp.host && config.smtp.user && config.smtp.password) {
      this.transporter = nodemailer.createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.port === 465, // true for 465, false for other ports
        auth: {
          user: config.smtp.user,
          pass: config.smtp.password,
        },
      });
      this.isConfigured = true;
      logger.info('Email service configured');
    } else {
      logger.warn('SMTP not configured. Email sending will be disabled.');
    }
  }

  /**
   * Send an auto-response email
   * @param {Object} params - Email parameters
   * @returns {Promise<Object>} Send result
   */
  async sendAutoResponse(params) {
    const { to, subject, body, ticketId } = params;

    if (!this.isConfigured) {
      logger.warn('Email service not configured, skipping send', { to, subject });
      return {
        success: false,
        error: 'SMTP not configured',
        messageId: null,
      };
    }

    try {
      const info = await this.transporter.sendMail({
        from: config.smtp.fromEmail,
        to,
        subject,
        text: body,
        headers: {
          'X-Auto-Response': 'true',
          'X-Ticket-ID': ticketId || 'unknown',
        },
      });

      logger.info('Auto-response email sent', {
        to,
        subject,
        messageId: info.messageId,
      });

      return {
        success: true,
        messageId: info.messageId,
        error: null,
      };
    } catch (error) {
      logger.error('Failed to send auto-response email', {
        to,
        subject,
        error: error.message,
      });

      return {
        success: false,
        error: error.message,
        messageId: null,
      };
    }
  }

  /**
   * Verify SMTP connection
   * @returns {Promise<boolean>}
   */
  async verifyConnection() {
    if (!this.isConfigured) {
      return false;
    }

    try {
      await this.transporter.verify();
      logger.info('SMTP connection verified');
      return true;
    } catch (error) {
      logger.error('SMTP connection verification failed', { error: error.message });
      return false;
    }
  }
}

export default new EmailService();

