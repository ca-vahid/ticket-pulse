# Auto-Response Environment Variables

Add these to your `backend/.env` file:

```bash
# ============================================
# OpenAI Configuration (Required for LLM features)
# ============================================
# Get your API key from: https://platform.openai.com/api-keys
OPENAI_API_KEY=sk-proj-your-api-key-here

# ============================================
# Webhook Authentication (Required)
# ============================================
# Generate a secure random secret:
# node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
WEBHOOK_SECRET=your-secure-random-webhook-secret-here

# ============================================
# SMTP Configuration (Required for sending emails)
# ============================================

# Gmail Example:
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=yourname@gmail.com
SMTP_PASSWORD=your-16-char-app-password  # Get from https://myaccount.google.com/apppasswords
SMTP_FROM_EMAIL=it-support@yourdomain.com

# Microsoft 365 Example:
# SMTP_HOST=smtp.office365.com
# SMTP_PORT=587
# SMTP_USER=yourname@yourdomain.com
# SMTP_PASSWORD=your-password
# SMTP_FROM_EMAIL=it-support@yourdomain.com

# SendGrid Example:
# SMTP_HOST=smtp.sendgrid.net
# SMTP_PORT=587
# SMTP_USER=apikey
# SMTP_PASSWORD=your-sendgrid-api-key
# SMTP_FROM_EMAIL=it-support@yourdomain.com
```

## Important Notes

1. **NEVER commit your .env file to Git**
2. For Gmail, you MUST use an App Password, not your regular password
3. The webhook secret should be shared with your ticketing system
4. OpenAI API usage is billed based on tokens used (~$0.002-0.003 per auto-response)

## Quick Setup

1. Copy the variables above to `backend/.env`
2. Replace placeholder values with your actual credentials
3. Restart the backend server
4. Configure business hours in the Settings UI

