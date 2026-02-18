# Auto-Response Setup Guide

## Overview

The Auto-Response feature uses AI (OpenAI GPT) to automatically classify incoming support tickets and send personalized acknowledgment emails to users. The system takes into account business hours, holidays, queue status, and the nature of the incoming request.

## Architecture

### Components

1. **Webhook Endpoint** (`/api/webhook/ticket`)
   - Receives incoming ticket notifications from your ticketing system
   - Authenticated via shared secret

2. **LLM Classification Service**
   - Analyzes email content using OpenAI GPT
   - Classifies source type (human vs automated)
   - Determines severity and category

3. **Availability Service**
   - Manages business hours and holiday calendars
   - Calculates ETA based on queue stats

4. **Response Generation Service**
   - Generates personalized responses using OpenAI GPT
   - Adapts tone based on classification

5. **Email Delivery Service**
   - Sends auto-responses via SMTP
   - Logs all activity for audit

## Configuration

### Environment Variables

Add these to your `.env` file:

```bash
# OpenAI Configuration
OPENAI_API_KEY=sk-your-openai-api-key-here

# Webhook Authentication
WEBHOOK_SECRET=your-secure-webhook-secret

# SMTP Configuration (for sending auto-responses)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@domain.com
SMTP_PASSWORD=your-app-password
SMTP_FROM_EMAIL=it-support@yourdomain.com
```

### OpenAI API Key

1. Go to https://platform.openai.com/api-keys
2. Create a new API key
3. Add to `.env` as `OPENAI_API_KEY`

**Note:** The system uses OpenAI SDK v6.9.0 (latest as of November 2024) and is configured to use GPT-4o by default. Update `backend/src/config/index.js` if you want to use a different model (e.g., gpt-4o, gpt-3.5-turbo, gpt-4-turbo).

### SMTP Configuration

#### Gmail Example
```bash
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=yourname@gmail.com
SMTP_PASSWORD=your-app-password  # Not your regular password!
```

To get a Gmail App Password:
1. Enable 2-factor authentication on your Google account
2. Go to https://myaccount.google.com/apppasswords
3. Generate an app password for "Mail"
4. Use that password in your `.env`

#### Microsoft 365 Example
```bash
SMTP_HOST=smtp.office365.com
SMTP_PORT=587
SMTP_USER=yourname@yourdomain.com
SMTP_PASSWORD=your-password
```

### Webhook Secret

Generate a secure random string:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Add to `.env`:
```bash
WEBHOOK_SECRET=your-generated-secret-here
```

## Database Setup

Run the migration to create the required tables:

```bash
cd backend
npx prisma migrate deploy
```

This creates:
- `business_hours` - Working hours configuration
- `holidays` - Holiday calendar
- `auto_responses` - Log of all auto-responses sent

## Business Hours Configuration

### Via UI (Recommended)

1. Navigate to Settings in the dashboard
2. Scroll to "Auto-Response Configuration"
3. Click "Add Hours" to define business hours
4. Set day of week, start time, end time
5. Enable/disable as needed
6. Click "Save Business Hours"

### Default Configuration

The system initializes with default business hours:
- Monday - Friday: 9:00 AM - 5:00 PM (PST)
- Weekends: Closed

### Via API

```bash
curl -X PUT http://localhost:3000/api/autoresponse/business-hours \
  -H "Content-Type: application/json" \
  -H "Cookie: your-session-cookie" \
  -d '{
    "hours": [
      {
        "dayOfWeek": 1,
        "startTime": "09:00",
        "endTime": "17:00",
        "isEnabled": true,
        "timezone": "America/Los_Angeles"
      }
    ]
  }'
```

## Holiday Configuration

### Via UI

1. Navigate to Settings
2. In "Auto-Response Configuration", find "Holidays" section
3. Click "Add Holiday" to manually add a holiday
4. Or click "Load Canadian" to auto-load Canadian statutory holidays

### Load Canadian Holidays

```bash
curl -X POST http://localhost:3000/api/autoresponse/holidays/load-canadian \
  -H "Content-Type: application/json" \
  -H "Cookie: your-session-cookie" \
  -d '{"year": 2024}'
```

### Manual Holiday Addition

```bash
curl -X POST http://localhost:3000/api/autoresponse/holidays \
  -H "Content-Type: application/json" \
  -H "Cookie: your-session-cookie" \
  -d '{
    "name": "Christmas Day",
    "date": "2024-12-25",
    "isRecurring": true,
    "country": "CA"
  }'
```

## Webhook Integration

### Configuring Your Ticketing System

Your ticketing system needs to send HTTP POST requests to:
```
https://your-domain.com/api/webhook/ticket
```

#### Headers Required
```
X-Webhook-Secret: your-webhook-secret
Content-Type: application/json
```

Or use Bearer token:
```
Authorization: Bearer your-webhook-secret
```

#### Payload Format

The webhook accepts flexible JSON formats. Recommended:

```json
{
  "ticketId": 12345,
  "freshserviceTicketId": 12345,
  "subject": "Password reset needed",
  "body": "I forgot my password and need help...",
  "senderEmail": "user@company.com",
  "senderName": "John Doe",
  "priority": 2,
  "status": "Open",
  "source": "Email",
  "createdAt": "2024-11-15T10:30:00Z"
}
```

Alternative formats are also supported (nested structures, different field names).

### FreshService Webhook Example

In FreshService:
1. Go to Admin → Workflow Automator
2. Create a new automation rule
3. Trigger: "Ticket is created"
4. Action: "Trigger Webhook"
5. URL: `https://your-domain.com/api/webhook/ticket`
6. Method: POST
7. Headers: `X-Webhook-Secret: your-secret`
8. Body template:
```json
{
  "ticketId": {{ticket.id}},
  "freshserviceTicketId": {{ticket.id}},
  "subject": "{{ticket.subject}}",
  "body": "{{ticket.description}}",
  "senderEmail": "{{ticket.requester.email}}",
  "senderName": "{{ticket.requester.name}}",
  "priority": {{ticket.priority}},
  "status": "{{ticket.status}}",
  "source": {{ticket.source}},
  "createdAt": "{{ticket.created_at}}"
}
```

### Testing the Auto-Response System

#### Option 1: UI Test (Recommended)

The easiest way to test is through the built-in UI:

1. Navigate to **Settings** in your dashboard
2. Scroll to **Test Auto-Response System** section
3. Fill in the test form:
   - **Sender Email**: Your email address (you'll receive the auto-response)
   - **Sender Name**: Test User
   - **Subject**: I need help with my password
   - **Body**: Describe a test issue
4. Click **Run Auto-Response Test**
5. View the results instantly in the UI
6. Check your email inbox for the auto-response

**Important:** This test uses the EXACT same code path as real webhook requests - it calls the same `processIncomingTicket()` function, so you're testing the real workflow.

#### Option 2: Webhook Endpoint Test

```bash
curl -X POST http://localhost:3000/api/webhook/ticket \
  -H "X-Webhook-Secret: your-webhook-secret" \
  -H "Content-Type: application/json" \
  -d '{
    "ticketId": 999,
    "subject": "Test ticket",
    "body": "This is a test",
    "senderEmail": "test@example.com",
    "senderName": "Test User"
  }'
```

Expected response:
```json
{
  "success": true,
  "message": "Ticket webhook processed successfully",
  "data": {
    "autoResponseId": 123,
    "classification": "human_request",
    "responseSent": true,
    "estimatedWaitMinutes": 45
  }
}
```

## How It Works

### Workflow

1. **Ticket arrives** → Webhook receives notification
2. **LLM Analysis** → GPT classifies the request:
   - Source type (human vs automated)
   - Severity (low/medium/high/urgent)
   - Category (password_reset, hardware_issue, etc.)
3. **Availability Check** → System checks:
   - Is it during business hours?
   - Is today a holiday?
4. **ETA Calculation** → Based on:
   - Current queue length
   - Number of active agents
   - Business hours status
5. **Response Generation** → GPT creates personalized reply:
   - Acknowledges receipt
   - Provides ETA
   - Adjusts tone based on classification
6. **Email Sent** → SMTP delivery to user
7. **Logging** → All details saved to database

### Classification Types

- `human_request` - Real user needing help → Warm, personalized response
- `automated_notification` - System-generated email → Brief acknowledgment
- `vendor_email` - External vendor communication → Professional note
- `mailing_list` - Bulk/newsletter email → Minimal response
- `out_of_office` - Auto-reply → Very brief acknowledgment
- `spam` - Spam/junk → Minimal acknowledgment

### Response Examples

**During Business Hours (Human Request):**
```
Dear John,

Thank you for contacting IT Support. We have received your request about "password reset" and will respond as soon as possible.

Current estimated response time: 30 minutes.
Queue status: 5 tickets, 3 active agents

Best regards,
IT Support Team
```

**After Hours:**
```
Dear John,

Thank you for contacting IT Support. We have received your request and will respond as soon as possible.

Your message was received outside of business hours. We will respond during our next business day. Base response time after opening: ~30 minutes

Best regards,
IT Support Team
```

**Automated Email:**
```
Thank you for your message. We have received this automated notification. If this requires action, please contact IT directly.
```

## Monitoring & Analytics

### View Recent Auto-Responses

```bash
curl http://localhost:3000/api/autoresponse/responses?limit=50 \
  -H "Cookie: your-session-cookie"
```

### Get Statistics

```bash
curl "http://localhost:3000/api/autoresponse/stats?startDate=2024-11-01&endDate=2024-11-30" \
  -H "Cookie: your-session-cookie"
```

Response:
```json
{
  "success": true,
  "data": {
    "total": 150,
    "sent": 145,
    "failed": 5,
    "byClassification": {
      "human_request": 120,
      "automated_notification": 20,
      "spam": 10
    },
    "afterHours": 30,
    "holidays": 5
  }
}
```

### Check Current Availability

```bash
curl http://localhost:3000/api/autoresponse/availability/check \
  -H "Cookie: your-session-cookie"
```

## Troubleshooting

### Auto-responses not sending

1. Check SMTP configuration in `.env`
2. Verify SMTP credentials are correct
3. Test SMTP connection:
   ```bash
   node backend/scripts/test-smtp.js
   ```
4. Check logs: `backend/logs/combined.log`

### Webhook not triggering

1. Verify webhook secret matches
2. Check webhook URL is accessible from ticketing system
3. Review webhook payload format
4. Check logs for authentication errors

### LLM classification failing

1. Verify OpenAI API key is valid
2. Check API quota/billing
3. Review logs for API errors
4. System will use fallback classification if LLM fails

### Missing business hours

Run initialization:
```bash
curl -X POST http://localhost:3000/api/autoresponse/business-hours/initialize \
  -H "Cookie: your-session-cookie"
```

## Cost Estimation

### OpenAI API Costs

Typical usage per auto-response:
- Classification: ~200-300 tokens ($0.0005 - $0.001)
- Response generation: ~400-500 tokens ($0.001 - $0.002)
- **Total per ticket: ~$0.002 - $0.003**

For 1000 tickets/month: **~$2-3/month**

### Recommendations

- Use GPT-4o for best results (still very affordable)
- Monitor token usage in database (`llm_tokens_used` field)
- Set up OpenAI usage alerts

## Security Considerations

1. **Webhook Secret** - Keep secure, rotate periodically
2. **API Keys** - Never commit to Git, use environment variables
3. **SMTP Credentials** - Use app-specific passwords, not main passwords
4. **Email Validation** - System logs sender emails for audit trail
5. **Rate Limiting** - Consider adding rate limits to webhook endpoint

## Future Enhancements

Possible improvements:
- [ ] Custom response templates per classification type
- [ ] Multi-language support
- [ ] Slack/Teams notifications instead of/in addition to email
- [ ] Machine learning to improve classification over time
- [ ] Integration with calendar APIs for dynamic holiday detection
- [ ] A/B testing different response styles

