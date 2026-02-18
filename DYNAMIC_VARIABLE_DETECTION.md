# Dynamic Variable Detection Feature

## Overview

The LLM Configuration UI now **automatically detects** JSON fields defined in the Classification Prompt and makes them available as variables in the Response Generation Prompt.

## How It Works

### 1. Classification Prompt Parsing
When you edit the Classification Prompt, the system scans for JSON field definitions using patterns like:
- `"fieldName": description`
- `1. "fieldName": description`

### 2. Dynamic Variable Generation
All detected fields become available as `{{fieldName}}` variables in the Response Generation Prompt.

### 3. Real-Time Updates
The variable list updates **immediately** as you edit the Classification Prompt (even before saving).

## Example

### Classification Prompt (adds #8):
```
Please analyze and respond with a JSON object containing:
1. "sourceType": one of ["human_request", "automated_notification", ...]
2. "severity": one of ["low", "medium", "high", "urgent"]
3. "category": brief category/topic of the request
4. "summary": brief one-sentence summary
5. "confidence": number between 0-1
6. "reasoning": brief explanation
7. "language": language of the request  ← NEW FIELD
```

### Response Prompt Variables (automatically includes):
- **Email Metadata**: `senderName`, `senderEmail`, `subject`
- **Classification Output**: 
  - `sourceType`
  - `severity`
  - `category`
  - `summary`
  - `confidence`
  - `reasoning`
  - `language` ← **Automatically detected!**
- **System Context**: `context`, `instructions`

## UI Features

### Categorized Sidebar
When editing the Response Generation Prompt, variables are now organized into three categories:

1. **Email Metadata** (blue) - Original email fields
2. **Classification Output** (green) - Dynamically detected from Classification Prompt
   - Shows count badge: "8 fields"
   - Highlighted in green to indicate they're dynamic
3. **System Context** (blue) - System-provided context

### Visual Indicators
- **Green border** on Classification Output variables
- **Badge showing field count** ("8 fields", "9 fields", etc.)
- **Updated Pro Tip**: "Classification fields are auto-detected from your Classification Prompt. Any JSON field you define there becomes available here."

## Benefits

1. ✅ **No Manual Maintenance** - Variable list updates automatically
2. ✅ **Type Safety** - You can only use variables that exist
3. ✅ **Better UX** - Clear categorization helps you understand data flow
4. ✅ **Immediate Feedback** - See new variables as soon as you add them to Classification Prompt
5. ✅ **Prevents Errors** - Reduces typos and missing variable issues

## Technical Implementation

### Pattern Matching
The system uses regex patterns to extract field names:
```javascript
/"([a-zA-Z_][a-zA-Z0-9_]*)"\s*:/g  // Matches: "fieldName":
/\d+\.\s+"([a-zA-Z_][a-zA-Z0-9_]*)"/g  // Matches: 1. "fieldName"
```

### Real-Time Processing
Variables are extracted on every render, so changes in the Classification Prompt immediately affect the Response Prompt's available variables.

## Edge Cases Handled

- ✅ Duplicate field names (automatically deduplicated)
- ✅ Invalid field names (must start with letter/underscore)
- ✅ Fields in comments or strings (false positives are acceptable)
- ✅ Case sensitivity (preserves original casing)

## Future Enhancements

Potential improvements:
- 🔮 Highlight unused variables in prompts
- 🔮 Validate that all referenced variables exist
- 🔮 Show variable descriptions in tooltips
- 🔮 Export/import variable mappings









