# LLM Admin Customization Guide

## Overview

The LLM Admin Panel gives you full control over how the AI classifies tickets and generates auto-responses. You can customize prompts, templates, ETA calculations, and classification rules through an intuitive UI.

## Accessing the Admin Panel

1. Navigate to **Settings** in your dashboard
2. Scroll down to the **LLM Configuration** section
3. Use the tabs to customize different aspects

## Features

### 1. Prompts Tab

Customize the AI prompts that drive classification and response generation.

#### Classification Prompt
- **Purpose**: Tells the AI how to analyze incoming emails
- **Placeholders Available**:
  - `{{senderName}}` - Sender's name
  - `{{senderEmail}}` - Sender's email address
  - `{{subject}}` - Email subject
  - `{{body}}` - Email body content

**Best Practices**:
- Keep instructions clear and specific
- Define the expected JSON output structure
- Include examples of each classification type
- Use consistent terminology

#### Response Generation Prompt
- **Purpose**: Tells the AI how to write auto-response emails
- **Placeholders Available**:
  - `{{senderName}}`, `{{senderEmail}}`, `{{subject}}`
  - `{{category}}` - Detected category (password_reset, etc.)
  - `{{severity}}` - Low/medium/high/urgent
  - `{{sourceType}}` - human_request, automated_notification, etc.
  - `{{summary}}` - One-sentence summary of the request
  - `{{context}}` - Business hours, ETA, holiday info
  - `{{instructions}}` - Tone-specific instructions

**Best Practices**:
- Maintain a professional but friendly tone
- Keep responses concise (3-5 sentences)
- Include relevant ETA information
- Adapt tone based on classification type

### 2. Templates & Signatures Tab

#### Email Signature
- Added to all auto-response emails
- Can include multiple lines
- Example:
  ```
  Best regards,
  IT Support Team
  Phone: (555) 123-4567
  Hours: Mon-Fri 9am-5pm PST
  ```

#### Fallback Message
- Used when OpenAI API fails or is unavailable
- Should be generic but professional
- Include contact information
- Example:
  ```
  Thank you for contacting IT Support. We have received your request and will respond as soon as possible.

  If you need immediate assistance, please call our helpdesk at (555) 123-4567.
  ```

**Best Practices**:
- Keep signature concise
- Include alternative contact methods
- Test fallback message regularly
- Update hours/contact info as needed

### 3. ETA Rules Tab

Control how estimated response times are calculated.

#### Base Response Time
- **Default**: 30 minutes
- **Range**: 5-240 minutes
- **Purpose**: Minimum ETA when queue is empty

#### Per-Ticket Delay
- **Default**: 10 minutes
- **Range**: 1-60 minutes
- **Purpose**: Additional time per ticket in queue
- **Formula**: `ETA = baseMinutes + (queueTickets / activeAgents) × perTicketDelay`

**Example Calculation**:
- Base: 30 minutes
- Per-ticket: 10 minutes
- Queue: 5 tickets
- Agents: 3 active
- **Result**: 30 + (5/3) × 10 = ~47 minutes

#### After-Hours Message
- Shown when ticket arrives outside business hours
- Example: "Your message was received outside of business hours. We will respond during our next business day."

#### Holiday Message
- Shown when ticket arrives on a holiday
- Example: "Your message was received on a holiday. We will respond on the next business day."

**Best Practices**:
- Set realistic base times
- Adjust per-ticket delay based on team capacity
- Include specific business hours in messages
- Test ETA calculations with various queue sizes

### 4. Classification Overrides Tab

Bypass AI classification with rule-based logic.

#### Domain Whitelist
- **Purpose**: Only process emails from specific domains
- **Format**: One domain per line
- **Example**:
  ```
  company.com
  example.org
  trusted.net
  ```
- **Behavior**: If whitelist has entries, ONLY these domains are processed

#### Domain Blacklist
- **Purpose**: Block specific domains
- **Format**: One domain per line
- **Example**:
  ```
  spam.com
  blocked.org
  marketing.biz
  ```
- **Behavior**: Emails from these domains are classified as spam

**Important Notes**:
- Whitelist takes precedence over blacklist
- If whitelist is empty, all domains are allowed (except blacklisted)
- Changes take effect immediately
- Use carefully to avoid blocking legitimate emails

#### Override Rules (Future Enhancement)
- Keyword-based classification overrides
- Example: Subject contains "invoice" → classify as vendor_email
- Currently stored in JSON format
- UI builder coming soon

### 5. History Tab

Track and revert configuration changes.

#### Features
- View last 20 configuration changes
- See who made changes and when
- View change notes
- Revert to any previous version

#### Version Control
- Each published configuration gets a new version number
- Drafts can be edited without affecting published version
- Reverting creates a new draft from historical version

**Best Practices**:
- Add meaningful notes when publishing
- Review history before major changes
- Test draft thoroughly before publishing
- Keep notes of why changes were made

## Draft vs. Published Workflow

### Draft Mode
- **Status Badge**: Yellow "Draft"
- **Behavior**: Changes saved but not active
- **Purpose**: Test and refine without affecting live responses
- **Editing**: Make unlimited changes

### Published Mode
- **Status Badge**: Green "Published v{number}"
- **Behavior**: Currently active configuration
- **Purpose**: Production configuration used for all auto-responses
- **Editing**: Cannot edit directly; create new draft first

### Publishing Workflow

1. **Edit Draft**: Make changes in any tab
2. **Save**: Click "Save" in each tab as you make changes
3. **Test**: Use the Auto-Response Test tool to verify
4. **Review**: Check all tabs for consistency
5. **Publish**: Click "Publish Changes" when ready
6. **Confirm**: Review confirmation dialog
7. **Live**: New configuration immediately active

**Important**: Publishing creates a new version and archives the old one. The change is immediate and affects all new auto-responses.

## Testing Your Configuration

### Using the Test Tool

1. Scroll to **Test Auto-Response System** section
2. Enter test email details
3. Click **Run Auto-Response Test**
4. Check results show expected classification
5. Verify email received with correct content

### What to Test

- **Classification Accuracy**: Does it detect human vs automated correctly?
- **Response Tone**: Is the tone appropriate for each classification type?
- **ETA Calculation**: Are wait times realistic?
- **Signature**: Does signature appear correctly?
- **After-Hours**: Test outside business hours
- **Holidays**: Test on configured holiday
- **Domain Filters**: Test with whitelisted/blacklisted domains

## Placeholders Reference

### Available in ALL Templates

| Placeholder | Description | Example |
|------------|-------------|---------|
| `{{senderName}}` | Sender's name | John Doe |
| `{{senderEmail}}` | Sender's email | john@example.com |
| `{{subject}}` | Email subject | Password reset needed |
| `{{body}}` | Email body content | I forgot my password... |

### Available in Response Generation

| Placeholder | Description | Example |
|------------|-------------|---------|
| `{{category}}` | Detected category | password_reset |
| `{{severity}}` | Issue severity | medium |
| `{{sourceType}}` | Email source type | human_request |
| `{{summary}}` | One-sentence summary | User needs password reset |
| `{{context}}` | Generated context | Within business hours. ETA: 30 min |
| `{{instructions}}` | Tone instructions | Generate a warm, professional response... |

## Tone Presets

The system uses different response strategies based on classification:

| Classification | Tone | Response Length |
|---------------|------|-----------------|
| `human_request` | Warm & professional | 3-5 sentences |
| `automated_notification` | Brief & professional | 2-3 sentences |
| `vendor_email` | Professional & courteous | 2-3 sentences |
| `mailing_list` | Minimal | 1-2 sentences |
| `out_of_office` | Minimal | 1-2 sentences |
| `spam` | Minimal | 1-2 sentences |

These are defined in the tone presets (stored in database but not yet editable in UI).

## Common Customizations

### Add Company Branding

**Signature Block**:
```
Best regards,
IT Support Team

Acme Corporation
Phone: (555) 123-4567
Email: itsupport@acme.com
Portal: https://support.acme.com
```

### Customize After-Hours Message

```
Your message was received outside of our business hours (Monday-Friday, 9am-5pm PST).

Our team will review your request and respond when we return. For urgent issues, please call our emergency line at (555) 999-8888.
```

### Adjust for High-Volume Periods

During busy times:
1. Increase **Base Response Time** to 45-60 minutes
2. Increase **Per-Ticket Delay** to 15-20 minutes
3. Update **After-Hours Message** to note high volume
4. Publish changes before peak period

### Industry-Specific Terminology

Update prompts to use your organization's terms:
- "Ticket" vs "Request" vs "Case"
- "Technician" vs "Agent" vs "Specialist"
- "Helpdesk" vs "Service Desk" vs "IT Support"

## Best Practices

### Prompt Engineering

1. **Be Specific**: Clearly define what you want
2. **Use Examples**: Show expected outputs
3. **Consistent Format**: Use same structure throughout
4. **Test Thoroughly**: Try various edge cases
5. **Iterate**: Refine based on real results

### Version Control

1. **Meaningful Notes**: Describe why changes were made
2. **Test Before Publishing**: Always use draft + test
3. **Small Changes**: Publish incremental improvements
4. **Document Externally**: Keep notes outside system too
5. **Review History**: Learn from past changes

### Testing Strategy

1. **Happy Path**: Normal human requests
2. **Edge Cases**: Automated emails, out-of-office, spam
3. **Timing**: During and outside business hours
4. **Holidays**: Test on configured holidays
5. **High Queue**: Simulate various queue sizes
6. **Fallback**: Test with OpenAI API disabled

### Monitoring

After publishing changes:

1. Check **Auto-Response Statistics** (in `/api/autoresponse/stats`)
2. Review **Classification Distribution**: Are types detected correctly?
3. Monitor **Token Usage**: Has it increased significantly?
4. Gather **User Feedback**: Are responses helpful?
5. Watch for **Errors**: Check logs for LLM failures

## Troubleshooting

### Changes Not Showing

**Problem**: Made changes but auto-responses unchanged  
**Solution**: Did you click "Publish Changes"? Drafts don't affect live responses.

### Placeholders Not Replacing

**Problem**: Email shows `{{senderName}}` instead of actual name  
**Solution**: Check placeholder spelling and ensure it's in the available list for that template.

### ETA Always Too High/Low

**Problem**: Calculated ETAs don't match reality  
**Solution**: Adjust Base Response Time and Per-Ticket Delay. Monitor actual response times and calibrate.

### Classification Inaccurate

**Problem**: AI misclassifies certain types  
**Solution**: Update classification prompt with specific examples. Consider override rules for known patterns.

### Fallback Message Used Too Often

**Problem**: Seeing fallback message frequently  
**Solution**: Check OpenAI API key, quota, and logs for errors. May need to handle rate limits.

## Security & Privacy

### Data Handling

- Email content sent to OpenAI for processing
- Configure usage policies with OpenAI
- All activity logged in `auto_responses` table
- Config history retained indefinitely

### Access Control

- Admin panel requires authentication
- All changes logged with user info
- No public API access to admin endpoints
- Webhook uses separate secret key

### Sensitive Information

**Recommendations**:
- Don't include passwords/keys in prompts
- Review fallback messages for sensitive data
- Sanitize email content if needed
- Comply with data retention policies

## API Reference

### Get Configuration

```bash
GET /api/admin/llm-settings/config?type=draft
GET /api/admin/llm-settings/config?type=published
```

### Update Sections

```bash
PUT /api/admin/llm-settings/prompts
PUT /api/admin/llm-settings/templates
PUT /api/admin/llm-settings/eta-rules
PUT /api/admin/llm-settings/overrides
```

### Publishing

```bash
POST /api/admin/llm-settings/publish
POST /api/admin/llm-settings/reset
```

### History

```bash
GET /api/admin/llm-settings/history?limit=20
POST /api/admin/llm-settings/revert
```

### Validation

```bash
POST /api/admin/llm-settings/validate
POST /api/admin/llm-settings/preview
```

## Support

For questions or issues:
- Check logs: `backend/logs/combined.log`
- Review history for recent changes
- Test with known-good configuration
- Check OpenAI API status
- Verify SMTP configuration

---

**Last Updated**: November 2024  
**Version**: 1.0

