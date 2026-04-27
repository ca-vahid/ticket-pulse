# Demo Mode Implementation Guide

This document describes how Ticket Pulse anonymizes real operational data for demos, training recordings, screenshots, and customer-safe walkthroughs. It is written as an implementation brief for another application, including Python/server-side adaptation notes.

## Goal

Demo Mode lets a user toggle the application from real data to realistic fake identities without changing the underlying database or source systems.

When enabled, the UI should show:

- Fake technician, requester, agent, manager, reviewer, and user names.
- Fake email addresses with a safe demo domain.
- Fake office/city/location values.
- Fake device/computer names.
- Scrubbed ticket subjects, descriptions, comments, AI rationales, notes, and other free-text fields.
- Fake profile photos or no photos with an initials fallback.
- A visible "Demo Mode" indicator so users know they are not recording real data.

The design requirement is that the same real value maps to the same fake value during one recording session. For example, if "Andrew Fong" becomes "Taylor Reed", then every instance of Andrew in the dashboard, timeline, assignment review, SSE updates, and popovers must also show "Taylor Reed". A new browser tab or explicit reshuffle should produce a fresh fake roster.

## Current Ticket Pulse Design

Ticket Pulse implements Demo Mode almost entirely in the frontend.

The backend, database, logs, FreshService data, and sync jobs keep real data. The browser rewrites API and SSE payloads after they arrive but before React components render them.

Current implementation files:

- `frontend/src/utils/demoMode/state.js`: local/session storage, on/off state, seed generation, reset notifications.
- `frontend/src/utils/demoMode/rng.js`: deterministic PRNG and stable string hashing.
- `frontend/src/utils/demoMode/dictionaries.js`: fake first names, last names, locations, company/device tokens, regexes, fake email domain.
- `frontend/src/utils/demoMode/mappings.js`: deterministic real-to-fake mapping caches.
- `frontend/src/utils/demoMode/scrubber.js`: recursive payload walker and free-text scrub pipeline.
- `frontend/src/utils/demoMode/index.js`: public API and React hooks.
- `frontend/src/components/DemoModeToggle.jsx`: user-facing toggle, reshuffle, and replace-photos option.
- `frontend/src/components/DemoModeBanner.jsx`: global visual reminder.
- `frontend/src/services/api.js`: axios response interceptors call the scrubber.
- `frontend/src/hooks/useSSE.js`: SSE event payloads call the scrubber.
- `frontend/public/demo-avatars/`: fake avatar images and `manifest.json`.
- `scripts/test-demo-scrub.mjs`: regression smoke test for leaks and avatar URL safety.

## Core Architecture

### 1. Single Chokepoint Scrubbing

The most important design decision is that data is scrubbed at centralized data-ingress points.

In Ticket Pulse:

- Normal HTTP API responses are scrubbed in the axios response interceptor.
- Long-timeout HTTP responses use the same response interceptor.
- Server-Sent Event payloads are scrubbed immediately after `JSON.parse`.
- Components only need manual demo hooks for labels that do not come from API responses, such as the authenticated user's display name or workspace names already stored in client context.

This avoids page-by-page anonymization bugs. New pages are protected automatically if they consume the shared API client or shared SSE hook.

Equivalent Python patterns:

- For a Python backend-rendered app, add a response middleware or template-context filter that scrubs response objects before rendering.
- For a Python API with a separate frontend, put scrub logic in the frontend API client if demo mode is per-browser and should not affect other users.
- For server-driven HTML, put scrub logic in a request-scoped service used by all view functions before sending data to templates.
- For JSON APIs where demo mode should be enabled by a user preference, add a middleware that checks a session flag and scrubs JSON responses before serialization.

Do not spread one-off calls across individual pages unless there is no shared request path.

### 2. No Source Data Mutation

Demo Mode must never write fake values to the database or upstream systems.

Scrubbing is a presentation-layer transformation. The source record IDs, timestamps, statuses, counts, categories, priorities, and business metrics remain unchanged unless a field itself contains sensitive text. This keeps the demo realistic while preventing fake data from polluting reporting, sync, audit logs, or support workflows.

### 3. Deterministic Per-Session Mapping

Ticket Pulse uses:

- `localStorage` for the enabled flag: Demo Mode stays on across reloads and tabs.
- `sessionStorage` for a random 32-bit seed: each browser tab or recording session gets a distinct fake roster.
- In-memory maps for real-to-fake assignments: values stay consistent while the tab lives.
- A "Reshuffle identities" action: generates a new seed, clears caches, and forces a data refresh.

The seed and mapping cache solve two competing requirements:

- Consistency inside one recording.
- Different fake identities across separate recordings.

Python equivalent:

- If scrubbing server-side, store `demo_mode_enabled` in the user's session.
- Store `demo_seed` in the user's session or signed cookie.
- Keep mapping caches request-scoped plus session-persisted, or rebuild them deterministically from seed plus value.
- If using multiple workers, do not rely only on process memory unless consistency across requests does not matter. Prefer session storage, cache storage keyed by session ID, or a deterministic hash-based mapper.

## Mapping Model

The implementation maps each sensitive class independently.

### Names

Real person names are mapped to fake full names.

Ticket Pulse builds a large shuffled roster from:

- 80 fake first names.
- 80 fake last names.
- Cartesian product: about 6,400 possible names.

The roster is shuffled by the session seed. Each newly seen real name gets the next unused fake name.

Rules:

- Normalize real-name cache keys with trim plus lowercase.
- Preserve consistency for the exact person across the entire session.
- Avoid reusing fake names while the roster has unused names.
- Fall back to `Demo User N` only if the roster is exhausted.
- Treat structured name fields as authoritative sources for known people.

Example:

```text
Andrew Fong       -> Taylor Reed
andrew fong       -> Taylor Reed
Anton Kuzmychev   -> Riley Carter
```

### Emails

Emails are mapped to safe fake emails.

Ticket Pulse:

- Detects email fields by key name and emails inside free text by regex.
- Converts the local part to a name-like string by replacing dots, underscores, and hyphens with spaces.
- Runs that local part through the same name mapper.
- Converts the fake name back to dot-separated lowercase.
- Uses the safe fake domain `acme.example`.

Example:

```text
andrew.fong@realcompany.com -> taylor.reed@acme.example
```

Rules:

- Always replace the domain.
- Keep email shape valid so the UI layout and copy/paste behavior remain realistic.
- Do not preserve real company domains or UPN suffixes.

### Locations and Offices

Locations are mapped to fake but plausible city/office names.

Ticket Pulse:

- Maps structured keys like `location`, `city`, `office`, `site`, `workplace`, and `workLocation`.
- Replaces known real office names inside free text.
- Uses fake Canadian city names that are valid in the app's map/location layer so pins still render.

Rules:

- Use a seeded shuffled location roster.
- Keep mappings stable during the session.
- If locations drive maps, choose fake locations that the map knows how to display.

### Timezones

Timezones can reveal geography. Ticket Pulse remaps selected real IANA timezone values to other valid IANA timezone values.

Example:

```text
America/Toronto    -> America/Halifax
America/Vancouver  -> America/Edmonton
America/Edmonton   -> America/Regina
```

Rules:

- Keep valid IANA timezone strings.
- Do not replace with arbitrary city text if date formatting depends on timezone validity.
- Only remap fields that are explicitly timezone fields.

### Device and Computer Names

Ticket Pulse detects company-style device names with a regex and maps them to fake machine tags.

Example:

```text
BGC-EDM-HV01 -> ACME-WS-042
```

The fake device name is built from:

- A fake company prefix, such as `ACME`, `NIMBUS`, or `ORION`.
- A fake device kind, such as `WS`, `LAP`, `SRV`, or `PC`.
- A three-digit number.

Rules:

- Hash the real computer name plus session seed to pick a stable prefix, kind, and number.
- Track used fake names to reduce collisions.
- Keep the fake machine format realistic enough for screenshots.

### Photos and Avatars

Ticket Pulse replaces real Azure AD or profile photo URLs with bundled fake avatar images.

The app ships:

- `frontend/public/demo-avatars/manifest.json`
- `avatar-001.png` through `avatar-050.png`

Runtime behavior:

- On module load, fetch the manifest.
- When a photo field is encountered, pick an avatar index from `hash(real_key) XOR session_seed`.
- Use the sibling person name or email as the avatar key when possible so the same fake person keeps the same fake face.
- Avoid duplicate avatars while unused avatar slots remain.
- If photos are disabled or the manifest is unavailable, return an empty URL so the existing initials fallback renders.

Important bug prevention:

- In JavaScript, force unsigned integer math before modulo: `((hash ^ seed) >>> 0) % files.length`.
- Otherwise negative indexes can produce `/demo-avatars/undefined`, causing broken images and possible alt-text leakage.
- Image components should either use empty `alt=""` for decorative avatars or handle `onError` by hiding the image and rendering initials.

Python equivalent:

- Store fake avatars in static assets.
- Keep a manifest list or enumerate files at startup.
- Use `hashlib` or a stable custom hash, not Python's built-in `hash()`, because Python's built-in hash is randomized per process.
- Pick with `stable_hash(value + seed) % len(avatars)`.
- Return a static URL such as `/static/demo-avatars/avatar-017.png`.

## Field Classification

The scrubber classifies fields by key name. These sets should be customized for the target app's schema.

### Name Fields

Values are treated as person names:

```text
name
fullName
displayName
requesterName
agentName
assignedBy
performedByName
performerName
createdByName
updatedByName
managerName
reviewerName
reporterName
firstName
lastName
techName
technicianName
assignedTechName
currentHolderName
holderName
pickerName
fromTechName
toTechName
rejectedByName
lastHolderName
previousHolderName
startAssignedByName
endActorName
performedBy
by
```

### Email Fields

Values are treated as emails:

```text
email
requesterEmail
agentEmail
userEmail
contactEmail
mail
upn
userPrincipalName
```

### Location Fields

Values are treated as locations:

```text
location
city
office
site
workplace
workLocation
```

### Free-Text Fields

Values are treated as mixed sensitive text:

```text
subject
description
descriptionText
body
note
notes
comment
comments
reason
summary
detail
details
shortDescription
longDescription
aiReasoning
aiSummary
aiSuggestionRationale
rationale
message
```

### Photo Fields

Values are treated as photo/avatar URLs:

```text
photoUrl
avatarUrl
avatar
picture
pictureUrl
_techPhotoUrl
techPhotoUrl
fromTechPhotoUrl
toTechPhotoUrl
profilePhoto
profilePicture
```

### Timezone Fields

Values are treated as IANA timezone strings:

```text
timezone
tz
```

### Safe Fields

These are intentionally left alone:

```text
id
role
status
priority
category
ticketCategory
createdAt
updatedAt
closedAt
resolvedAt
firstAssignedAt
date
startDate
endDate
weekStart
monthStart
freshserviceTicketId
freshserviceId
workspaceId
```

The target Python app must build its own list from its actual JSON/template schema. The safest process is:

1. Export representative API responses or template contexts.
2. Inventory every field that can contain identity, location, device, tenant, customer, or free-text data.
3. Add exact key names to the classification sets.
4. Add a leak test with real sample tokens.

## Free-Text Scrubbing Pipeline

Free text is harder than structured fields because ticket subjects and comments mix real names, device names, company names, alert titles, and technical phrases.

Ticket Pulse applies replacements in this order:

1. Emails.
2. Computer/device names.
3. Known internal company tokens and domains.
4. Known office/location names.
5. Known people already discovered from structured fields.
6. Trigger-based generic person-name matches.

The order matters. Emails are replaced first so the local part is not separately interpreted as a name. Known people are replaced before generic name detection so exact known values win. Generic detection is last and intentionally conservative.

### Known Internal Tokens

Maintain a fixed list of company/customer/internal strings that must never appear in screenshots.

Examples:

```text
Real Company Name
REALCO
realcompany.com
internal SaaS domain
helpdesk mailbox domains
```

Replace these with a neutral company label such as `Acme` or a safe fake domain such as `acme.example`.

### Known People in Text

The scrubber first walks the payload and remembers every structured person name. Then, when it processes text fields, it builds a dynamic regex from all known real names and replaces exact occurrences.

This catches cases like:

```text
Structured field: requesterName = "Muhammad Shahidullah"
Subject: "Alert involving Muhammad Shahidullah"
Result: "Alert involving Taylor Reed"
```

### Trigger-Based Generic Name Catcher

Some names only appear in free text and never appear in structured fields. Ticket Pulse uses a conservative trigger-based regex:

- Only match 2 to 3 Title-Case tokens.
- Only match after clear triggers like `for`, `by`, `from`, `with`, `involving`, `to`, `Hire`, `Hi`, `Hello`, `Dear`, or after a colon.
- Use a stoplist for phrases that look like names but are not people.

This catches:

```text
New Hire: Mahmoud Al-Riffai
Request for Dan Parker
Alert involving Muhammad Shahidullah
```

It avoids scrubbing ordinary technical phrases like:

```text
Significant Anomaly
Application or Service Principal
Cybersecurity Questionnaire
Access Denied
```

The target Python implementation should start conservative. False negatives are easier to add to field rules or known-token lists than false positives that make ticket subjects nonsensical.

## Recursive Scrubber Behavior

Ticket Pulse mutates parsed response objects in place. The logic is:

1. If Demo Mode is off, return data unchanged.
2. If payload is null, primitive, or non-object, return unchanged.
3. First pass: recursively collect structured person names from known name fields.
4. Second pass: recursively scrub every object and array.
5. Skip safe keys.
6. For string values, apply key-specific mapper.
7. For nested objects and arrays, recurse.
8. Protect against pathological recursion depth.
9. Catch scrubber errors and return the original data rather than breaking the app.

Recommended max depth: about 30.

Cycle handling:

- JSON API responses usually cannot contain object cycles.
- Python template contexts can contain rich objects. Convert them to plain dictionaries/lists first, or track visited object IDs.

## Python Reference Design

The exact integration depends on the target Python framework. The core service can be framework-agnostic.

### Suggested Modules

```text
app/
  demo_mode/
    __init__.py
    state.py          # session flags, seed, reshuffle
    rng.py            # stable hash, seeded random helpers
    dictionaries.py   # fake names, locations, regexes, safe domain
    mappings.py       # DemoMapper class
    scrubber.py       # recursive scrub_response and scrub_free_text
    middleware.py     # Flask/Django/FastAPI integration
    tests/
      test_scrubber.py
      test_mappings.py
      fixtures/
```

### Stable Hashing

Do not use Python's built-in `hash()` for persistent demo mapping. It is salted per process.

Use `hashlib.blake2s`, `hashlib.sha256`, or FNV-1a.

Example:

```python
import hashlib

def stable_u32(value: str) -> int:
    digest = hashlib.blake2s(value.encode("utf-8"), digest_size=4).digest()
    return int.from_bytes(digest, "big", signed=False)
```

### Session State

For Flask-style apps:

```python
import secrets
from flask import session

def is_demo_mode() -> bool:
    return session.get("demo_mode_enabled") is True

def set_demo_mode(enabled: bool) -> None:
    session["demo_mode_enabled"] = bool(enabled)
    if enabled and "demo_seed" not in session:
        session["demo_seed"] = secrets.randbits(32)

def get_demo_seed() -> int:
    seed = session.get("demo_seed")
    if seed is None:
        seed = secrets.randbits(32)
        session["demo_seed"] = seed
    return int(seed) & 0xFFFFFFFF

def reshuffle_demo_seed() -> int:
    seed = secrets.randbits(32)
    session["demo_seed"] = seed
    session.pop("demo_mapping_cache", None)
    return seed
```

For Django:

- Use `request.session["demo_mode_enabled"]`.
- Use `request.session["demo_seed"]`.
- Mark `request.session.modified = True` when updating nested cache values.

For FastAPI:

- Use signed session middleware, server-side session storage, or a secure cookie.
- Avoid storing large mapping caches in cookies. Prefer deterministic mapping or server-side cache keyed by session ID.

### Mapping Service Shape

```python
class DemoMapper:
    def __init__(self, seed: int, cache: dict | None = None):
        self.seed = seed & 0xFFFFFFFF
        self.cache = cache or {
            "names": {},
            "emails": {},
            "locations": {},
            "computers": {},
            "avatars": {},
        }
        self.used_fake_names = set(self.cache.get("names", {}).values())

    def map_name(self, real_name: str) -> str:
        ...

    def map_email(self, real_email: str) -> str:
        ...

    def map_location(self, real_location: str) -> str:
        ...

    def map_computer(self, real_computer: str) -> str:
        ...

    def map_avatar(self, real_key: str) -> str:
        ...
```

Implementation notes:

- Normalize cache keys with `strip().lower()`.
- Keep real values out of logs.
- If caches are stored in session, cap their size or expire them with the session.
- If using deterministic direct mapping instead of roster pop, collision handling must still prevent two real people from frequently sharing the same fake identity.

### Recursive Scrubber Shape

```python
def scrub_response(data, mapper: DemoMapper):
    known_people = set()
    collect_people(data, known_people)
    return scrub_node(data, mapper, known_people, depth=0, seen=set())
```

Core behavior:

- For dictionaries, iterate over key/value pairs.
- For lists/tuples, scrub each item.
- For strings, choose mapper by key classification.
- For safe keys, return unchanged.
- For unknown keys with nested data, recurse.
- Return a new object if mutating framework objects is risky.

Recommended server-side approach:

- Clone or serialize to plain JSON first.
- Scrub the plain JSON structure.
- Return the scrubbed response.

This avoids mutating ORM objects that might be reused later in the request.

## Framework Integration Options

### Option A: Frontend Scrubbing

Use this when the Python app has a separate JavaScript frontend.

Pros:

- Per-browser toggle is simple.
- No server changes to JSON API logic.
- Backend logs and audit behavior remain untouched.
- New endpoints are protected if they use the shared API client.

Cons:

- Server-rendered HTML is not protected.
- Browser devtools/network still show real JSON responses.
- Download/export endpoints need separate handling.

### Option B: Server-Side JSON Middleware

Use this when the Python backend owns the API and the team wants network responses anonymized too.

Pros:

- Browser devtools and network captures show fake data.
- Works for thin frontends and server-rendered pages.
- Centralized enforcement can cover exports.

Cons:

- Must be careful not to scrub non-JSON binary responses.
- Must avoid scrubbing write requests or data persisted back to the database.
- Session and cache consistency across workers need thought.

### Option C: Server-Rendered Template Scrubbing

Use this when the Python app renders HTML templates.

Pros:

- Protects the actual rendered UI.
- Can be added at context-building boundaries.

Cons:

- More risk of missing page-specific context variables.
- Requires discipline around template helpers.
- Less automatic than JSON middleware unless all pages share a context builder.

Recommended for the Python team:

- If the app is API plus frontend, implement frontend chokepoints plus server-side export scrubbing.
- If the app is Flask/Django templates, implement request/session Demo Mode plus a central `scrub_context()` before rendering templates.
- If privacy needs include browser network recordings, implement server-side JSON middleware.

## UI Requirements

Implement a small but obvious control surface:

- A "Demo Mode" toggle in the main app header.
- Active styling when enabled.
- A dropdown option to "Reshuffle identities".
- A dropdown option to enable/disable "Replace photos".
- A persistent page-level banner or pill when active, for example: `DEMO MODE - identities anonymized`.
- A forced data refresh after toggling or reshuffling so stale real values are not left in component state.

Important state behavior:

- Turning Demo Mode on should immediately generate a seed if none exists.
- Turning Demo Mode off should show real data again after refresh.
- Reshuffling should clear mapping caches and refresh data.
- The visible banner should appear globally on every authenticated page.

## API, SSE, Streaming, and Exports

Demo Mode must cover every path where real data reaches the screen or output files.

Checklist:

- Shared API client responses.
- Long-running API responses.
- SSE events.
- WebSocket messages, if the Python app uses them.
- Streaming JSON/chunked responses.
- CSV exports.
- PDF/Excel reports.
- Downloaded screenshots or generated share links.
- Server-rendered template context.
- Auth/session/user profile display values.
- Workspace/customer/account names stored in client state.
- Browser notifications/toasts.
- Error messages that may include real request details.

For streaming events:

- Parse each event payload.
- Scrub immediately.
- Then pass to state reducers or UI callbacks.

For exports:

- Decide whether Demo Mode should affect exports.
- If yes, scrub the export data at the export generation boundary.
- Clearly label exported files as demo/anonymized.

## Testing and Regression Coverage

A demo-mode leak test should use real-looking representative payloads and explicit banned tokens.

Minimum tests:

1. Structured name fields are replaced.
2. Structured email fields are replaced and use the fake domain.
3. Structured location fields are replaced.
4. Timezone fields stay valid.
5. Free-text subjects scrub emails, device names, company tokens, known locations, known people, and triggered names.
6. Technical phrases are not over-scrubbed.
7. Same input maps to same fake value within a session.
8. Reshuffle changes mappings.
9. Demo Mode off returns data unchanged.
10. Avatar URLs never point to missing or `undefined` files.
11. Broken avatar images do not expose real names in visible alt text.
12. SSE/WebSocket payloads use the same scrubber as normal HTTP responses.
13. Fields added by new features are covered by classification sets.

Recommended test shape:

```python
def test_demo_scrub_no_sensitive_tokens_leak():
    payload = load_fixture("dashboard_assignment_timeline.json")
    mapper = DemoMapper(seed=12345)
    scrubbed = scrub_response(payload, mapper)
    flat = json.dumps(scrubbed)

    banned = [
        "Andrew Fong",
        "andrew.fong",
        "realcompany.com",
        "BGC-EDM-HV01",
        "Vancouver",
        "Real Company Name",
    ]

    leaks = [token for token in banned if token in flat]
    assert leaks == []
```

Run this test in CI. Make it easy for developers to add banned tokens when screenshots reveal a new leak.

## Security and Privacy Boundaries

Demo Mode is a presentation safety feature, not a data security boundary unless implemented server-side for all outputs.

If scrubbing only happens in the browser:

- The network response still contains real data.
- Browser devtools can still inspect real payloads.
- Backend logs still contain real values.
- API consumers still receive real values.

This is acceptable for screen recordings where the app UI is the only captured surface. It is not enough for sharing raw HAR files, API outputs, exports, logs, database dumps, or granting untrusted users access to production data.

If the Python app needs stronger guarantees, scrub server-side before serialization and cover exports.

## Operational Guidance

Add a "How to record safely" note for users:

1. Open the app.
2. Enable Demo Mode.
3. Confirm the global demo banner is visible.
4. Wait for the page to refresh.
5. Navigate through the pages needed for recording.
6. Do not capture browser devtools unless server-side scrubbing is enabled.
7. Use Reshuffle if the current fake roster should be changed.

Add a developer checklist for new features:

- Does the feature display names, emails, locations, devices, customer/account names, or free text?
- Does the data arrive through the shared API/SSE path?
- If not, has it been wrapped in a demo label/helper?
- Are new field names added to the scrubber classification sets?
- Is there a fixture test for the new payload shape?
- Do image fallbacks avoid visible real-name leakage?

## Implementation Milestones for the Python Team

### Milestone 1: Core Library

- Add fake dictionaries.
- Add stable hashing and seeded random helpers.
- Add `DemoMapper`.
- Add structured field classification.
- Add recursive `scrub_response`.
- Add free-text scrub pipeline.
- Add unit tests for mapper stability and no-leak fixtures.

### Milestone 2: App Integration

- Add session flag and seed.
- Add toggle endpoint or UI action.
- Add response middleware or frontend API interceptor.
- Add SSE/WebSocket scrubbing.
- Add manual helpers for session/user labels outside API responses.
- Add global demo banner.

### Milestone 3: Photos and Polish

- Add fake avatar assets and manifest.
- Replace profile photo URLs while Demo Mode is enabled.
- Add image failure fallback.
- Add "Replace photos" option.
- Add "Reshuffle identities" option.
- Force refresh after mode changes.

### Milestone 4: Coverage Hardening

- Test representative pages and exports.
- Add banned-token leak fixtures.
- Add CI test.
- Audit new feature payloads.
- Add documentation for users and developers.

## Acceptance Criteria

The implementation is complete when:

- A user can enable Demo Mode from the UI without developer tools.
- Every visible identity in the main workflows is fake.
- The same real person is represented consistently across pages and live updates.
- New tab/session or reshuffle can produce a fresh roster.
- Real profile photos are not visible.
- Real emails, internal domains, office names, and device names do not appear in the app UI.
- Ticket subjects remain readable and operationally realistic after scrubbing.
- Demo Mode off restores normal real-data behavior.
- Automated tests fail if known real tokens leak in representative payloads.

## Common Pitfalls

- Scrubbing only the dashboard while detail pages, search results, popovers, or assignment review still leak names.
- Forgetting live update paths such as SSE or WebSockets.
- Forgetting auth/session labels such as "Welcome, Real User".
- Replacing names inconsistently because each page creates its own mapper.
- Using Python's built-in `hash()`, which is not stable across processes.
- Scrubbing too aggressively and turning technical alert names into fake people.
- Leaving real profile photos visible for one render frame while fake avatars load.
- Broken images showing real names through `alt` text.
- Missing export/report/download paths.
- Treating frontend-only Demo Mode as a true access-control boundary.

