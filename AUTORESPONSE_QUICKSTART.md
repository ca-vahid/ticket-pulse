# Auto-Response Feature - Quick Start

## 🚀 What Was Added

Your Ticket Pulse dashboard now includes **AI-powered auto-responses** that automatically:
- Classify incoming support tickets (human vs automated, severity, category)
- Send personalized acknowledgment emails to users
- Calculate realistic wait times based on queue status
- Respect business hours and holidays

## ⚡ Quick Setup (5 minutes)

### 1. Add to `.env` file

Edit `backend/.env` and add:

```bash
# OpenAI (get key from https://platform.openai.com/api-keys)
OPENAI_API_KEY=sk-your-api-key-here

# Webhook secret (generate random string)
WEBHOOK_SECRET=your-random-secret-here

# Email settings (Gmail example)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASSWORD=your-app-password
SMTP_FROM_EMAIL=it-support@yourdomain.com
```

**Generate webhook secret:**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Gmail App Password:** https://myaccount.google.com/apppasswords

### 2. Run Database Migration

```bash
cd backend
npx prisma migrate deploy
npx prisma generate
```

### 3. Restart Backend

```bash
npm run dev
```

### 4. Configure Business Hours

1. Open your dashboard
2. Go to **Settings**
3. Scroll to **Auto-Response Configuration**
4. Set your business hours (default: Mon-Fri 9am-5pm)
5. Click "Save Business Hours"

### 5. Set Up Webhook in FreshService

1. Go to FreshService → Admin → Workflow Automator
2. Create automation: "When ticket is created"
3. Add action: "Trigger Webhook"
4. URL: `https://your-domain.com/api/webhook/ticket`
5. Method: POST
6. Headers: `X-Webhook-Secret: your-secret`
7. Body:
```json
{
  "ticketId": {{ticket.id}},
  "subject": "{{ticket.subject}}",
  "body": "{{ticket.description}}",
  "senderEmail": "{{ticket.requester.email}}",
  "senderName": "{{ticket.requester.name}}"
}
```

## ✅ Test It

### Option 1: Use the UI (Recommended)

1. Go to **Settings** in your dashboard
2. Scroll to **Test Auto-Response System**
3. Fill in:
   - Your email address (you'll receive the auto-response)
   - Subject and body of test ticket
4. Click "Run Auto-Response Test"
5. Check your email inbox!

**This uses the EXACT same workflow as real tickets!**

### Option 2: Command Line Test

```bash
cd backend
node scripts/test-autoresponse.js
```

### Option 3: Manual API Call

```bash
curl -X POST http://localhost:3000/api/webhook/ticket \
  -H "X-Webhook-Secret: your-secret" \
  -H "Content-Type: application/json" \
  -d '{"ticketId":999,"subject":"Test","body":"Test message","senderEmail":"test@example.com","senderName":"Test User"}'
```

## 📊 How It Works

```
Ticket Created
    ↓
Webhook triggered
    ↓
AI classifies ticket (human vs automated, severity)
    ↓
Check business hours & holidays
    ↓
Calculate ETA from queue
    ↓
AI generates personalized response
    ↓
Email sent to user
    ↓
Everything logged in database
```

## 💰 Cost

- **OpenAI**: ~$0.003 per auto-response (~$3/month for 1000 tickets)
- **Email**: Free (Gmail/Microsoft 365 SMTP included)

## 📚 Full Documentation

- **Setup Guide**: `docs/AUTO_RESPONSE_SETUP.md`
- **Implementation Details**: `docs/AUTO_RESPONSE_IMPLEMENTATION_SUMMARY.md`
- **Environment Config**: `docs/ENV_AUTORESPONSE_EXAMPLE.md`

## 🎯 What Users Get

### Human Request (Business Hours)
```
Dear John,

Thank you for contacting IT Support. We have received your 
request about "password reset" and will respond as soon as 
possible.

Current estimated response time: 30 minutes.
Queue status: 5 tickets, 3 active agents

Best regards,
IT Support Team
```

### After Hours
```
Dear Sarah,

Thank you for contacting IT Support. We have received your 
request and will respond as soon as possible.

Your message was received outside of business hours. We will 
respond during our next business day. Base response time after 
opening: ~30 minutes

Best regards,
IT Support Team
```

### Automated Email
```
Thank you for your message. We have received this automated 
notification. If this requires action, please contact IT 
directly.
```

## 🔧 Configuration Options

### Business Hours
- Settings → Auto-Response → Business Hours
- Add multiple time blocks per day
- Enable/disable by day of week
- Timezone support

### Holidays
- Settings → Auto-Response → Holidays
- Manual entry or load Canadian holidays
- Recurring vs one-time
- Enable/disable individual holidays

### View Auto-Responses
```bash
# Recent responses
curl http://localhost:3000/api/autoresponse/responses?limit=50 -H "Cookie: session-cookie"

# Statistics
curl http://localhost:3000/api/autoresponse/stats -H "Cookie: session-cookie"
```

## ⚠️ Troubleshooting

**Emails not sending?**
- Check SMTP credentials in `.env`
- Gmail requires App Password (not regular password)
- Check `backend/logs/combined.log`

**Webhook not working?**
- Verify `WEBHOOK_SECRET` matches in `.env` and FreshService
- Check webhook URL is publicly accessible
- Test with: `curl http://localhost:3000/api/webhook/test -H "X-Webhook-Secret: your-secret"`

**LLM classification failing?**
- Verify `OPENAI_API_KEY` is correct
- Check OpenAI account has credits
- System will use fallback classification if needed

## 🎉 That's It!

You're all set! New tickets will automatically receive personalized responses based on:
- Whether it's a real user or automated email
- Current business hours
- Number of tickets in queue
- Holiday schedule

Questions? Check the full docs in `/docs/AUTO_RESPONSE_SETUP.md`

