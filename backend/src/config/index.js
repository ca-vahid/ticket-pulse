import dotenv from 'dotenv';
import { z } from 'zod';

// Load environment variables
dotenv.config();

// Define validation schema for environment variables
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('3000').transform(Number),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  SESSION_SECRET: z.string().min(1, 'SESSION_SECRET is required'),
  CORS_ORIGIN: z.string().optional(),
  FRESHSERVICE_API_KEY: z.string().optional(),
  FRESHSERVICE_DOMAIN: z.string().optional(),
  FRESHSERVICE_WORKSPACE_ID: z.string().optional(),
  ADMIN_PASSWORD_HASH: z.string().optional(),
  ADMIN_EMAILS: z.string().optional(),
  AZURE_KEY_VAULT_URL: z.string().optional(),
  APPLICATION_INSIGHTS_CONNECTION_STRING: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  WEBHOOK_SECRET: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.string().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM_EMAIL: z.string().optional(),
});

// Validate environment variables
let config;
try {
  config = envSchema.parse(process.env);
} catch (error) {
  console.error('❌ Invalid environment variables:');
  console.error(error.errors);
  process.exit(1);
}

export default {
  // Node environment
  env: config.NODE_ENV,
  isDevelopment: config.NODE_ENV === 'development',
  isProduction: config.NODE_ENV === 'production',
  isTest: config.NODE_ENV === 'test',

  // Server
  port: config.PORT,

  // Database
  database: {
    url: config.DATABASE_URL,
  },

  // CORS
  cors: {
    origin: config.NODE_ENV === 'production'
      ? (config.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean)
      : ['http://localhost:5173', 'http://127.0.0.1:5173'],
  },

  // Session
  session: {
    secret: config.SESSION_SECRET,
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
    rememberMeMaxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  },

  // FreshService API
  freshservice: {
    apiKey: config.FRESHSERVICE_API_KEY,
    domain: config.FRESHSERVICE_DOMAIN,
    workspaceId: config.FRESHSERVICE_WORKSPACE_ID,
    baseUrl: config.FRESHSERVICE_DOMAIN
      ? `https://${config.FRESHSERVICE_DOMAIN}/api/v2`
      : null,
  },

  // Admin
  admin: {
    passwordHash: config.ADMIN_PASSWORD_HASH,
  },

  // Azure
  azure: {
    keyVaultUrl: config.AZURE_KEY_VAULT_URL,
    applicationInsightsConnectionString: config.APPLICATION_INSIGHTS_CONNECTION_STRING,
  },

  // Sync settings
  sync: {
    ticketInterval: 30, // seconds
    technicianInterval: 300, // 5 minutes
    defaultTimezone: 'America/Los_Angeles',
  },

  // OpenAI
  openai: {
    apiKey: config.OPENAI_API_KEY,
    model: 'gpt-5.1', // Default GPT-5.1 thinking model (overridable)
  },

  // Webhook
  webhook: {
    secret: config.WEBHOOK_SECRET || 'dev-webhook-secret-change-in-production',
  },

  // SMTP
  smtp: {
    host: config.SMTP_HOST,
    port: config.SMTP_PORT ? parseInt(config.SMTP_PORT, 10) : 587,
    user: config.SMTP_USER,
    password: config.SMTP_PASSWORD,
    fromEmail: config.SMTP_FROM_EMAIL || 'noreply@ticketpulse.local',
  },
};
