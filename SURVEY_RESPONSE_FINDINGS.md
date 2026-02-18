# Survey Response Investigation - INC-199938

## Summary of Findings

### What We Found:
1. **Survey submission is tracked** - There's a conversation/activity that says "Josephine Morgenroth has submitted the survey response" on 2025-11-18T19:08:53Z
2. **Active survey exists** - "IT Satisfaction Survey" (ID: 1000015367) is active in the system
3. **Survey metadata is captured** - We know WHO submitted and WHEN

### What We CANNOT Find via API v2:
❌ Survey score (1-4 rating)
❌ Survey comment/feedback text
❌ Any `/satisfaction_responses` or `/survey_results` endpoint
❌ Survey data in ticket object (even with include parameters)
❌ Survey data in conversations or activities

### API Endpoints Tested (All Failed):
- `/tickets/{id}/satisfaction` - 404
- `/tickets/{id}/survey` - 404  
- `/tickets/{id}/survey_responses` - 404
- `/satisfaction_responses` - 404
- `/survey_results` - 404
- `/surveys/{id}/survey_results` - 404
- `/surveys/{id}/responses` - 404
- `/surveys/{id}/feedback` - 404
- `/feedbacks` - 404
- `/analytics` - 404
- `/reports` - 404

### What We Know from Testing:
```json
// Activity captured:
{
  "actor": {
    "id": 1002062125,
    "name": "Josephine Morgenroth"
  },
  "content": " Responded to the survey",
  "created_at": "2025-11-18T19:08:53Z"
}

// Conversation captured:
{
  "id": 1040624489,
  "body_text": "<div>Josephine Morgenroth has submitted the survey response</div>",
  "created_at": "2025-11-18T19:08:53Z",
  "source": 5,
  "incoming": true
}
```

## Possible Scenarios:

### Scenario A: Data Only in Web UI
The survey responses (score + comments) might only be accessible through the FreshService web interface and not exposed via API v2.

### Scenario B: Different API Endpoint
There might be a specific endpoint we haven't discovered yet, possibly:
- Requiring special permissions
- Part of admin/analytics API
- Different base URL path

### Scenario C: Custom Fields
The survey data might be stored in custom_fields or a hidden field in the ticket.

### Scenario D: Report/Export API
The data might only be accessible via a reports/export mechanism.

## Questions for User:

1. **Where do you see the score of 1 and the long response?**
   - In FreshService web UI?
   - In an email notification?
   - In a report?
   - Via another integration?

2. **Can you provide a screenshot or the exact location?**
   - This will help us identify the correct data source

3. **Do you have access to:**
   - FreshService admin panel?
   - Survey configuration?
   - Any export/report features for survey data?

## Next Steps:

Once we know where the survey data is visible, we can:
1. Reverse-engineer the web UI API calls (if it's in the web interface)
2. Find the correct API endpoint
3. Determine if we need special API permissions
4. Build a workaround if API doesn't expose this data

## Potential Workarounds:

If API v2 doesn't expose survey data:
1. **Web scraping** - Parse the web UI (not ideal)
2. **Webhook** - Set up a webhook to capture survey submissions in real-time
3. **Email parsing** - If survey notifications are sent via email, parse those
4. **Manual entry** - UI for manual entry of survey responses (least automated)
5. **API v3/Beta** - Check if newer API version has this feature

