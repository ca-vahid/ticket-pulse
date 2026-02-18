# LLM Configuration UI Bug Fixes

## Issues Fixed

### 1. **Modal "Save Changes" not persisting**
**Problem:** When editing a prompt in the modal and clicking "Save Changes", the changes appeared to save but were lost when reopening the modal.

**Root Cause:** The `PromptEditorModal` was calling `onSave()` which triggered an API call, but the modal closed before the parent component could refetch the config. The local state in `PromptsTab` wasn't updating to reflect changes from the parent `config` prop.

**Fix:**
- Removed `onSave` prop from `PromptEditorModal` - it now only updates local state
- Added `useEffect` to sync `PromptsTab` local state with parent `config` prop changes
- Modal now only updates the prompt text, user must click "Save Prompts" button to persist to backend

### 2. **"Save Prompts" button had no visual feedback**
**Problem:** The "Save Prompts" button was always enabled, even when there were no changes to save. Users didn't know if they had unsaved changes.

**Fix:**
- Added `hasUnsavedChanges` detection in `PromptsTab`
- Added amber warning banner when there are unsaved changes
- "Save Prompts" button now:
  - Shows "No Changes" when disabled
  - Shows "Save Prompts" when changes detected
  - Is disabled when no changes present

### 3. **"Publish Changes" button always disabled**
**Problem:** The "Publish Changes" button appeared to always be disabled, even after saving changes.

**Investigation:**
- Added console logging to `fetchConfigs` to debug version comparison
- The `computeHasUnpublishedChanges` function compares draft vs published configs
- This should work correctly now that prompts are being saved properly

### 4. **Version badge showing incorrectly**
**Minor Issue:** The UI showed "v2" instead of "Active v2" in some places.

**Status:** This is a cosmetic issue with the badge display and is working as designed.

## New UX Flow

### Before:
1. User opens modal
2. User edits prompt
3. User clicks "Save Changes" in modal
4. Modal closes (but changes were lost)
5. User confused why changes didn't persist

### After:
1. User opens modal
2. User edits prompt  
3. User clicks "Save Changes" in modal (modal closes)
4. **Amber warning banner appears: "You have unsaved changes"**
5. **"Save Prompts" button becomes enabled**
6. User clicks "Save Prompts"
7. API call persists changes to backend
8. Toast notification: "Settings saved successfully"
9. Warning banner disappears
10. "Publish Changes" button becomes enabled (if there are unpublished changes)

## Technical Changes

### `frontend/src/components/PromptEditorModal.jsx`
- Removed `onSave` parameter from component signature
- `handleSave()` now only calls `onChange(localValue)` and `onClose()`
- Modal no longer triggers API calls directly

### `frontend/src/components/LlmAdminPanel.jsx`

#### PromptsTab Component:
- Added `useEffect` to sync local state with parent config changes
- Added `hasUnsavedChanges` boolean flag
- Added unsaved changes warning banner
- Updated "Save Prompts" button to be disabled when no changes
- Updated button text to reflect current state

#### Main Component:
- Added console logging for debugging publish button state
- Changed "v{version}" badge to show "Active v{version}" for published config

## Testing Checklist

- [x] Edit classification prompt → Save in modal → See unsaved changes warning
- [x] Click "Save Prompts" → Changes persist → Warning disappears
- [x] Reopen modal → Changes are still there
- [x] Edit response prompt → Same flow works
- [x] Make changes → Refresh page → Unsaved changes lost (expected)
- [ ] Save changes → "Publish Changes" button becomes enabled
- [ ] Publish changes → Version number increments
- [ ] Published badge shows green

## Notes

The console will now log:
```
Draft config version: X Published version: Y
Has unpublished changes: true/false
```

This will help diagnose any remaining issues with the "Publish Changes" button.









