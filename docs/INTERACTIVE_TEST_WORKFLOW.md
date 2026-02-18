# Interactive Test Workflow - Documentation

## Overview

The Interactive Test Workflow provides a comprehensive dry-run mode for testing auto-responses. It shows every step of the LLM pipeline with full visibility into prompts, responses, and data transformations before sending emails.

## Key Features

### 1. Dry Run Mode (No Email Sent Initially)
- Run complete workflow without sending email
- Review every step and output
- Decide whether to send after inspection
- Keeps results in memory for review

### 2. Step-by-Step Execution Trace
Shows 8 distinct steps:
1. **Load Configuration** - Current published LLM config
2. **Domain & Override Check** - Whitelist/blacklist filtering
3. **AI Classification** - LLM analyzes the email
4. **Availability Check** - Business hours and holiday detection
5. **ETA Calculation** - Queue-based wait time estimation
6. **Build Response Context** - Assemble context for response generation
7. **AI Response Generation** - LLM creates personalized reply
8. **Prepare Email** - Final email with signature

### 3. Interactive UI Components

**Left Timeline View**:
- Vertical cards for each execution step
- Shows input (prompts, settings) and output (JSON results)
- Expandable JSON inspector with syntax highlighting
- Copy buttons for debugging
- Auto-scrolls to active step

**Right Side Navigation**:
- Quick-jump tabs for each step
- Summary card with key metrics
- Send/Close action buttons
- Real-time status updates

### 4. Future-Proof Design
- Generic JSON renderer auto-displays new fields
- Adding `userSentiment` to classification prompt automatically shows in output
- No UI changes needed for new LLM response fields

## How It Works

### Backend (`autoResponseServiceDryRun.js`)

**Dry Run Execution**:
```javascript
POST /api/autoresponse/test
Body: { senderEmail, senderName, subject, body }

Response: {
  success: true,
  executionTrace: {
    steps: [
      {
        step: 0,
        name: "Load Configuration",
        duration: 45,
        input: { ... },
        output: { version: 1, baseResponseMinutes: 30, ... }
      },
      {
        step: 2,
        name: "AI Classification", 
        duration: 1234,
        input: { prompt: "...", model: "gpt-4o" },
        output: { 
          classification: {
            sourceType: "human_request",
            severity: "medium",
            category: "password_reset",
            userSentiment: "neutral" // Future field auto-included
          },
          tokensUsed: 250
        }
      },
      // ... more steps
    ]
  },
  summary: {
    classification: "human_request",
    severity: "medium",
    estimatedWaitMinutes: 47,
    totalTokens: 687,
    totalDuration: 5234
  },
  email: {
    to: "user@example.com",
    subject: "Re: Password reset needed",
    body: "Dear User,\n\nThank you for...\n\nBest regards,\nIT Team"
  },
  sendData: { /* Cached for send endpoint */ }
}
```

**Send After Review**:
```javascript
POST /api/autoresponse/test/send
Body: { sendData: { ...fromDryRun } }

Response: {
  success: true,
  messageId: "<smtp-message-id>",
  error: null
}
```

### Frontend (`AutoResponseTestInteractive.jsx`)

**Component Structure**:
- Form input section (collapsible after run)
- Two-column results layout:
  - Right: Quick-jump nav + summary + actions
  - Left: Timeline cards with step details

**JsonInspector Component**:
- Recursively renders objects/arrays
- Highlights specified keys (sourceType, severity, etc.)
- Collapsible sections
- Copy to clipboard
- Syntax coloring (booleans purple, numbers blue, strings gray)

**Workflow States**:
1. **Input** - Show form
2. **Testing** - Show spinner
3. **Review** - Show timeline + tabs
4. **Sent** - Show success message
5. **Error** - Show error details

## Usage

### 1. Run Dry Run

1. Go to Settings → Test Auto-Response
2. Fill in:
   - Sender Email (e.g., `vhaeri@bgcengineering.ca`)
   - Sender Name (or click "Use Sample Data" for random name)
   - Subject
   - Email Body (20 rows for detailed input)
3. Click **Run Dry Run Test**
4. Wait for processing (typically 5-10 seconds)

### 2. Review Results

**Quick Jump Tabs** (right side):
- Click any step to scroll timeline to that section
- Active step highlighted in blue
- Checkmarks show completed steps

**Timeline Cards** (left side):
- Each card shows:
  - Step number and name
  - Execution duration
  - Input section (prompts, parameters)
  - Output section (JSON results)
- Expandable JSON with copy buttons
- Highlighted keys for important values

### 3. Inspect Specific Steps

**Step 2: AI Classification**
- Input: Full classification prompt with placeholders filled
- Output: Complete JSON including `sourceType`, `severity`, `category`, `summary`, `confidence`, `reasoning`
- **Future fields** like `userSentiment` automatically appear here

**Step 6: AI Response Generation**
- Input: Full response prompt with context and instructions
- Output: Generated email subject, body, and tone

**Step 7: Email Preview**
- Final email with signature
- Exactly what will be sent to the user

### 4. Send or Close

**Send Email Button**:
- Sends the exact email shown in preview
- Uses the same response generated by LLM
- Shows success/failure status
- Cannot send twice (button disabled after send)

**Close & Clear Button**:
- Dismisses results without sending
- Returns to input form
- Clears all dry-run data

## Adding Custom LLM Fields

### Example: Adding `userSentiment` to Classification

**1. Update Classification Prompt** (in LLM Configuration):
```
Please analyze and respond with a JSON object containing:
1. "sourceType": ...
2. "severity": ...
3. "userSentiment": one of ["happy", "neutral", "frustrated", "angry"]
4. "category": ...
... etc
```

**2. Save and Publish** the updated prompt

**3. Run Dry Run Test**:
- The test will now show `userSentiment` in Step 2 output automatically
- JsonInspector will render it with proper formatting
- No code changes needed!

**4. Use in Response Prompt**:
Add `{{userSentiment}}` placeholder to your response prompt or tone instructions.

The entire new field flows through the system automatically because:
- Classification returns full JSON
- Dry-run stores complete output
- JsonInspector recursively renders all keys
- Future fields just appear in the timeline

## Debugging Workflow

### Troubleshooting Classification Issues

1. Run dry run
2. Jump to **Step 2: AI Classification**
3. Expand Input section → Copy classification prompt
4. Review prompt to see exactly what was sent to LLM
5. Expand Output section → Review classification result
6. Check `confidence` and `reasoning` fields
7. If incorrect, edit classification prompt in LLM Configuration

### Troubleshooting Response Issues

1. Run dry run
2. Jump to **Step 6: AI Response Generation**
3. Expand Input → Review filled response prompt
4. Check `context` and `instructions` values
5. Expand Output → Review generated response
6. If tone is off, edit tone presets or response prompt

### Checking ETA Accuracy

1. Run dry run
2. Jump to **Step 4: ETA Calculation**
3. Review input: `baseResponseMinutes`, `perTicketDelayMinutes`, queue stats
4. Verify output: `estimatedMinutes` matches expectations
5. Adjust ETA rules if calculation is wrong

## JSON Inspector Features

### Auto-Detection
- Automatically renders any JSON structure
- Handles nested objects and arrays
- No predefined schema needed

### Syntax Highlighting
- Strings: Gray
- Numbers: Blue
- Booleans: Purple
- Null: Light gray
- Highlighted keys: Green (bold)

### Collapsible Sections
- Click chevron to expand/collapse
- Saves screen space for large objects
- Defaults to expanded

### Copy Functionality
- One-click copy of entire JSON
- Formatted with 2-space indentation
- Visual feedback (checkmark)

## API Response Structure

```typescript
{
  success: boolean,
  executionTrace: {
    steps: [
      {
        step: number,
        name: string,
        duration: number, // milliseconds
        input: object,    // Step inputs (prompts, settings, etc.)
        output: object    // Step outputs (results, JSON, etc.)
      }
    ],
    payload: object // Original webhook payload
  },
  summary: {
    classification: string,
    severity: string,
    category: string,
    estimatedWaitMinutes: number,
    isAfterHours: boolean,
    isHoliday: boolean,
    configVersion: number,
    totalDuration: number,
    totalTokens: number
  },
  email: {
    to: string,
    subject: string,
    body: string
  },
  sendData: object // Cached for send endpoint
}
```

## Benefits

### For Admins
- **Transparency**: See exactly what LLM receives and returns
- **Debugging**: Pinpoint issues in specific steps
- **Confidence**: Review before committing to send
- **Learning**: Understand how prompts affect outputs

### For Development
- **Testing**: Verify prompt changes without spam
- **Iteration**: Quick feedback loop for tuning
- **Documentation**: Self-documenting with step names
- **Future-proof**: New fields automatically visible

### For Compliance
- **Audit Trail**: Full trace of decision-making
- **Reproducibility**: Exact inputs/outputs logged
- **Verification**: Confirm prompts match policy
- **Accountability**: Know which config version was used

## Advanced Use Cases

### A/B Testing Prompts

1. Save current config as draft A
2. Run dry run, note classification
3. Update prompts (draft B)
4. Run dry run, compare Step 2/6 outputs
5. Publish preferred version

### Training Team Members

1. Run sample tickets through dry run
2. Show timeline to explain workflow
3. Point out key variables in each step
4. Demonstrate how prompts affect outputs

### Cost Optimization

1. Run dry runs to check token usage
2. Review Step 2 and Step 6 outputs
3. Shorten prompts if needed
4. Verify token count in summary

## Limitations

- Dry-run data not persisted to database
- Results cleared on browser refresh
- Cannot edit email before send (future enhancement)
- Limited to 8 predefined steps (expandable)

## Future Enhancements

Possible improvements:
- [ ] Save dry-run results to database
- [ ] Edit email before send
- [ ] Compare multiple dry runs side-by-side
- [ ] Export timeline as PDF/JSON
- [ ] Replay dry runs with different configs
- [ ] Add performance metrics chart
- [ ] Syntax highlighting in prompts
- [ ] Diff view for config changes

---

**Version**: 1.0  
**Date**: November 15, 2024  
**Status**: ✅ Complete - Production ready

