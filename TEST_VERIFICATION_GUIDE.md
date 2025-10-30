# Test Verification Guide - ViewMode-Based Data Selection Fix

## Summary of Fixes Applied

### Phase 1: Code Changes Verified ✅

**Backend (`backend/src/routes/dashboard.routes.js`)**
- Line 256: Weekly endpoint now transforms tickets: `weeklyTickets: (tech.weeklyTickets || []).map(transformTicket),`
- Line 450: Technician weekly endpoint also transforms tickets
- **Impact**: Weekly view can now search by requester name

**Frontend Dashboard (`frontend/src/pages/Dashboard.jsx`)**
- Line 615-622: `getTechTickets()` now uses `viewMode` to select correct data (critical fix)
  ```javascript
  const getTechTickets = (tech) => {
    if (viewMode === 'weekly') {
      return tech.weeklyTickets || [];
    } else {
      return tech.tickets || [];
    }
  };
  ```
- Line 735-741: Field assignment uses `viewMode`, not field existence checks
- Line 11: Imports centralized `filterTickets` utility
- **Impact**: Daily and weekly views now always use the correct dataset

**Frontend TechnicianDetailNew (`frontend/src/pages/TechnicianDetailNew.jsx`)**
- Line 7: Imports centralized filtering utilities
- Line 362: Uses `getAvailableCategories()` for categories
- Line 394: Uses centralized `filterTickets()` for filtering
- **Impact**: Technician detail page now uses same filtering logic

**Centralized Utility (`frontend/src/utils/ticketFilter.js`)**
- Single source of truth for filtering logic
- Used consistently across all views
- **Impact**: Same filtering behavior everywhere

---

## What Should Happen (Expected Behavior)

### Daily View Test

**Setup**: Open dashboard, ensure in daily view

**Test 1: Search for "bst"**
- Expected behavior:
  - Search filters daily tickets (open/pending from TODAY only)
  - Shows technicians with matching tickets from today
  - Stats update to show only filtered tickets
  - Result count updates

**Test 2: Switch to Weekly View**
- Same search term "bst" still active
- Expected behavior:
  - Switches to weekly dataset (all tickets assigned this week)
  - May show DIFFERENT number of technicians than daily view
  - This is CORRECT because the dataset is different
  - Weekly includes tickets from earlier in the week
  - Filtering LOGIC is identical, but applied to different data

**Test 3: Clear and Re-search**
- Clear search in weekly view
- Search for "bst" again
- Expected behavior:
  - Same technicians appear as before
  - Consistent results each time

### Key Insight: Different Results = Correct!

```
Daily View + Search "bst"
├─ Data: Only TODAY's tickets
├─ Example: 4 technicians with "bst" tickets today
└─ Result: Show 4 people

Weekly View + Search "bst"
├─ Data: ALL tickets assigned THIS WEEK
├─ Example: 5 technicians with "bst" tickets this week
└─ Result: Show 5 people (one more from earlier in week)

✅ Both use the SAME filterTickets() function
✅ Different results because different data = CORRECT
```

---

## Test Checklist

### Test 1: Basic Daily View Filtering
- [ ] Open dashboard (daily view by default)
- [ ] Search for "bst"
- [ ] Verify technicians appear with matching tickets
- [ ] Note the number of technicians shown (e.g., 4)
- [ ] Verify stats cards update (openTicketCount, etc.)
- [ ] Result count at top shows correct number

### Test 2: Switch to Weekly View
- [ ] Click "Weekly" button
- [ ] Same search "bst" still active (should persist)
- [ ] Verify technicians appear
- [ ] Note the number of technicians shown (e.g., 5 - may be different!)
- [ ] Verify stats cards show weekly stats
- [ ] Verify result count updates

### Test 3: Verify Different Data = Different Results
- [ ] In weekly view with "bst" search, if you see a technician NOT in daily view
- [ ] This is CORRECT because weekly includes tickets from entire week
- [ ] Search for something from earlier in the week (not today)
- [ ] Daily view: Should show 0 results
- [ ] Weekly view: Should show that technician
- [ ] This proves viewMode-based selection is working

### Test 4: Category Filtering
- [ ] Open daily view
- [ ] Search "bst" + select a category filter
- [ ] Verify results match BOTH search AND category
- [ ] Switch to weekly view
- [ ] Same search + category should still apply
- [ ] Results may differ due to different data (correct!)

### Test 5: Clear Filters
- [ ] In weekly view with filters active
- [ ] Click "Clear" or remove search term
- [ ] Verify all technicians reappear
- [ ] Verify stats reset to full counts

### Test 6: Technician Detail Page
- [ ] In daily view with search "bst"
- [ ] Click a technician from filtered results
- [ ] Verify search term appears in TechnicianDetail page
- [ ] Go back to dashboard
- [ ] Verify search is still there

### Test 7: Category Filter in Weekly
- [ ] Switch to weekly view
- [ ] Filter by category
- [ ] Verify only that category shows
- [ ] Combine with search "bst"
- [ ] Verify results match both criteria

### Test 8: Edge Cases
- [ ] Search for something with special characters
- [ ] Search for ticket ID (numbers)
- [ ] Search for requester name
- [ ] Search for category name
- [ ] All should work consistently in both views

---

## What to Check in Browser Developer Tools

### Network Tab
1. Go to Dashboard with daily view
2. Open DevTools → Network
3. Search for "bst"
4. Check API call - should get `/api/dashboard` with daily data
5. Switch to weekly view
6. Should call `/api/dashboard/weekly` with weekly data
7. Verify both responses contain the fields:
   - Daily: `tickets` array
   - Weekly: `weeklyTickets` array

### Console Tab
1. No errors should appear
2. No warnings about "Rendered fewer hooks than expected"
3. Components should render without issues

### React DevTools (if installed)
1. Check that `viewMode` state changes when switching views
2. Verify `searchTerm` persists across view switches
3. Verify `filteredTechnicians` updates correctly

---

## Common Issues and Troubleshooting

### Issue 1: Search doesn't work in weekly view
**Symptom**: Search works in daily view but not weekly
**Check**:
- Verify backend was restarted (see fix at line 256)
- In Network tab, check weekly response has `requesterName` field
- Try searching by ticket ID instead of requester name

**Fix**: Restart backend with `npm run dev --prefix backend`

### Issue 2: Same technicians show in daily and weekly
**Symptom**: Daily and weekly views show identical results for same search
**Reason**: Could be correct if:
- All tickets were created today
- Search term doesn't match earlier week's tickets
- Verify by searching for something from 2-3 days ago

**To verify fix**: Search "bst" should show different technicians in daily vs weekly if "bst" appears in multiple days' tickets

### Issue 3: Stats not updating
**Symptom**: Stats stay the same even with filters
**Check**:
- Verify recalculateTechStats function is being called
- Check that filterTickets is returning correct count
- Try refreshing page (might be stale state)

**Fix**: Clear browser cache and reload

### Issue 4: Filters disappear when switching views
**Symptom**: Search term clears when going daily → weekly
**Expected**: Search should persist (part of fix)
**Check**: Ensure code has `searchTerm` and `selectedCategories` in state

---

## Success Criteria

### Daily and Weekly Views Are Consistent ✅
- [x] Both use `filterTickets()` from centralized utility
- [x] Both search the same fields: subject, ID, requester name, category
- [x] Both apply category filter with AND logic
- [x] Both recalculate stats from filtered tickets

### ViewMode-Based Data Selection Works ✅
- [x] Daily view uses `technician.tickets`
- [x] Weekly view uses `technician.weeklyTickets`
- [x] Selection based on current `viewMode`, not field existence
- [x] No cross-contamination between datasets

### Backend Transformation in Place ✅
- [x] Weekly endpoint calls `.map(transformTicket)`
- [x] `requesterName` field available for search in weekly view
- [x] Same data structure in both daily and weekly

### Result: Different datasets can have different search results, but filtering logic is identical

```
BEFORE (Broken):
Daily search "bst" → filters weeklyTickets (wrong data!)
Weekly search "bst" → filters weeklyTickets (correct data)
Result: Different people show up, inconsistent logic

AFTER (Fixed):
Daily search "bst" → filters tickets (correct data!)
Weekly search "bst" → filters weeklyTickets (correct data)
Result: Same logic, may be different people (correct because different data)
```

---

## Next Steps

1. **Run the tests above** and verify all pass
2. **Commit the changes** with message:
   ```
   refactor: centralize ticket filtering with viewMode-based data selection

   - Fix getTechTickets() to use viewMode instead of field existence checks
   - Fix field assignment to use viewMode for correct data selection
   - Backend: Add ticket transformation to weekly endpoint
   - All views now use centralized filterTickets() utility
   - Daily and weekly views have identical filtering logic

   This prevents cross-contamination between daily and weekly datasets
   and ensures consistent filtering behavior across all views.
   ```
3. **Clean up the todo** - remove old task tracking if using git-based tracking

---

## Questions?

Refer to:
- `FILTERING_ARCHITECTURE.md` - Technical architecture details
- `CENTRALIZED_FILTERING_SUMMARY.md` - Implementation summary
- `frontend/src/utils/ticketFilter.js` - Filtering implementation
- Code comments in `Dashboard.jsx` lines 613-741 - Critical fixes explained
