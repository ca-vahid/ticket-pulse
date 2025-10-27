# FreshService Data Fields Documentation

## Overview

This document provides a comprehensive reference of all data fields fetched from the FreshService API and stored in the Ticket Pulse database. This information is crucial for future updates, troubleshooting, and understanding what data is available.

**Last Updated**: October 19, 2025
**FreshService API Version**: v2

---

## Table of Contents

1. [Ticket Fields](#ticket-fields)
2. [Requester Fields](#requester-fields)
3. [Technician/Agent Fields](#technicianagent-fields)
4. [Sync Process](#sync-process)
5. [Database Schema Mapping](#database-schema-mapping)
6. [API Parameters](#api-parameters)

---

## Ticket Fields

### Core Ticket Information

| FreshService Field | Database Column | Type | Description | Example |
|-------------------|-----------------|------|-------------|---------|
| `id` | `freshserviceTicketId` | BigInt | Unique ticket ID from FreshService | `195748` |
| `subject` | `subject` | Text | Ticket title/subject line | `"New Computer Setup"` |
| `description` | `description` | Text | HTML description of the ticket | `"<div>Please set up...</div>"` |
| `description_text` | `descriptionText` | Text | Plain text version of description | `"Please set up..."` |
| `status` | `status` | String | Current ticket status (mapped) | `"Open"`, `"Pending"`, `"Closed"` |
| `priority` | `priority` | Integer | Priority level (1-4) | `1` (Urgent), `2` (High), `3` (Medium), `4` (Low) |

### Assignment & Tracking

| FreshService Field | Database Column | Type | Description | Example |
|-------------------|-----------------|------|-------------|---------|
| `responder_id` | `assignedFreshserviceId` (temp) | BigInt | ID of assigned technician | `2000012345` |
| N/A (computed) | `assignedTechId` | Integer | Internal technician ID (resolved from responder_id) | `6` |
| N/A (computed) | `isSelfPicked` | Boolean | Whether technician assigned to themselves | `true` |
| N/A (computed from activities) | `assignedBy` | String | Name of person who assigned the ticket | `"Gaby Tonnova"` or `null` |

### Requester Information

| FreshService Field | Database Column | Type | Description | Example |
|-------------------|-----------------|------|-------------|---------|
| `requester_id` | `requesterId` | BigInt | FreshService ID of ticket requester | `2000023456` |
| `requester.name` | `requesterName` | String | Full name of requester | `"John Smith"` |
| `requester.email` | `requesterEmail` | String | Email of requester | `"jsmith@company.com"` |

**Note**: Requester data is only included when the API request includes `include=requester` parameter.

### Timestamps

| FreshService Field | Database Column | Type | Description | Example |
|-------------------|-----------------|------|-------------|---------|
| `created_at` | `createdAt` | DateTime | When ticket was created | `2025-10-18T17:18:02.000Z` |
| `updated_at` | `updatedAt` | DateTime | Last update time | `2025-10-19T10:30:15.000Z` |
| `resolved_at` | `resolvedAt` | DateTime | When ticket was resolved | `2025-10-18T19:45:00.000Z` |
| `closed_at` | `closedAt` | DateTime | When ticket was closed | `2025-10-18T20:00:00.000Z` |
| `due_by` | `dueBy` | DateTime | Due date for ticket | `2025-10-20T17:00:00.000Z` |
| `fr_due_by` | `frDueBy` | DateTime | First response due date | `2025-10-18T18:00:00.000Z` |

### Additional Metadata

| FreshService Field | Database Column | Type | Description | Example |
|-------------------|-----------------|------|-------------|---------|
| `source` | `source` | Integer | Ticket source | `1` (Email), `2` (Portal), `3` (Phone), etc. |
| `category` | `category` | String | Ticket category | `"Hardware"`, `"Software"` |
| `sub_category` | `subCategory` | String | Ticket sub-category | `"Laptop"`, `"Network"` |
| `department.name` | `department` | String | Department name | `"IT Support"` |
| `is_escalated` | `isEscalated` | Boolean | Whether ticket is escalated | `false` |
| `workspace_name` | `workspaceName` | String | Workspace name (internal) | `"Primary Workspace"` |

### Status Mapping

FreshService uses numeric status codes. We map them to readable strings:

| FreshService Status | Mapped Status | Description |
|--------------------|---------------|-------------|
| `2` | `"Open"` | New or active ticket |
| `3` | `"Pending"` | Awaiting response |
| `4` | `"Resolved"` | Solution provided |
| `5` | `"Closed"` | Ticket completed |
| Other | `"In Progress"` | Working on ticket |

### Priority Mapping

| FreshService Priority | Mapped Priority | Label |
|----------------------|----------------|-------|
| `1` | `1` | Urgent |
| `2` | `2` | High |
| `3` | `3` | Medium |
| `4` | `4` | Low |

---

## Requester Fields

When `include=requester` is specified in the API request, FreshService returns a nested `requester` object:

```json
{
  "requester": {
    "id": 2000023456,
    "name": "John Smith",
    "email": "jsmith@company.com",
    "phone": "+1-555-1234",
    "mobile": "+1-555-5678",
    "department_names": ["Engineering"],
    "can_see_all_tickets_from_associated_departments": false,
    "reporting_manager_id": null,
    "address": null,
    "time_zone": "Pacific Time (US & Canada)",
    "created_at": "2023-01-15T10:20:30Z",
    "updated_at": "2025-10-15T14:22:10Z"
  }
}
```

### Fields Currently Stored

- `requester.name` → `requesterName`
- `requester.email` → `requesterEmail`
- `requester_id` (top level) → `requesterId`

### Fields Available But Not Stored

The following fields are available from the `requester` object but are currently **not stored**:

- `phone` - Requester's phone number
- `mobile` - Requester's mobile number
- `department_names` - Array of department names
- `time_zone` - Requester's timezone
- `reporting_manager_id` - Manager's FreshService ID
- `address` - Physical address
- `created_at` - When requester account was created
- `updated_at` - When requester account was last updated

**To add these fields in the future:**
1. Update `backend/prisma/schema.prisma` with new columns
2. Create a database migration
3. Update `backend/src/integrations/freshserviceTransformer.js` to map the fields
4. Update frontend components to display the new data

---

## Technician/Agent Fields

### Core Agent Information

| FreshService Field | Database Column | Type | Description | Example |
|-------------------|-----------------|------|-------------|---------|
| `id` | `freshserviceId` | BigInt | FreshService agent ID | `2000012345` |
| `first_name + last_name` | `name` | String | Full name | `"Andrii Grynik"` |
| `email` | `email` | String | Email address | `"agrynik@bgcengineering.ca"` |
| `time_zone` | `timezone` | String | Timezone | `"Mountain Time (US & Canada)"` |
| `location_id` | `location` | String | Office location | `"Vancouver"` |
| `active` | `isActive` | Boolean | Whether agent is active | `true` |
| `workspace_id` | `workspaceId` | BigInt | FreshService workspace ID | `2` |

### Fields Available But Not Stored

- `job_title` - Agent's job title
- `department_ids` - Array of department IDs
- `reporting_manager_id` - Manager's ID
- `address` - Physical address
- `background_information` - Agent bio/notes
- `scoreboard_level_id` - Gamification level
- `member_of` - Groups agent belongs to
- `observer_of` - Groups agent observes
- `roles` - Array of role objects
- `signature` - Email signature
- `occasional` - Whether occasional agent
- `created_at` - When agent was created
- `updated_at` - When agent was last updated

---

## Sync Process

### Ticket Sync Flow

1. **API Request**:
   ```javascript
   GET /api/v2/tickets?workspace_id={id}&include=requester&per_page=100
   ```

2. **Data Transformation**:
   - Raw FreshService data → `transformTicket()` function
   - Maps FreshService fields to database schema
   - Resolves technician IDs from `responder_id`

3. **Assignment Analysis**:
   - Fetches ticket activities: `GET /api/v2/tickets/{id}/activities`
   - Analyzes first assignment activity
   - Determines if `isSelfPicked` based on actor vs. assignee
   - Extracts `assignedBy` name from activity

4. **Database Upsert**:
   - Creates or updates ticket in PostgreSQL
   - Stores all mapped fields
   - Creates audit log entry

### Incremental vs. Full Sync

**Incremental Sync** (default):
- Uses `updated_since` parameter
- Fetches only tickets modified since last sync
- Fast and efficient
- Runs every 5 minutes automatically

```javascript
GET /api/v2/tickets?updated_since=2025-10-19T10:00:00Z&include=requester
```

**Full Sync** (manual):
- Fetches all tickets from last 30 days
- Use when adding new fields or fixing data
- Trigger via: `POST /api/sync/trigger?fullSync=true`

```javascript
GET /api/v2/tickets?updated_since=2025-09-19T00:00:00Z&include=requester
```

### Rate Limits

- **FreshService Limit**: 5000 requests/hour
- **Per-page Limit**: 100 tickets max per request
- **Strategy**: 1 request per second to avoid 429 errors
- **Timeout**: 30 seconds per request

---

## Database Schema Mapping

### Tickets Table

```sql
CREATE TABLE tickets (
  -- IDs
  id SERIAL PRIMARY KEY,
  freshservice_ticket_id BIGINT UNIQUE NOT NULL,
  assigned_tech_id INTEGER REFERENCES technicians(id),

  -- Core Info
  subject TEXT,
  description TEXT,
  description_text TEXT,
  status VARCHAR(50) NOT NULL,
  priority INTEGER DEFAULT 3,

  -- Requester
  requester_id BIGINT,
  requester_name VARCHAR(255),
  requester_email VARCHAR(255),

  -- Timestamps
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL,
  assigned_at TIMESTAMP,
  resolved_at TIMESTAMP,
  closed_at TIMESTAMP,
  due_by TIMESTAMP,
  fr_due_by TIMESTAMP,

  -- Assignment
  is_self_picked BOOLEAN DEFAULT FALSE,
  assigned_by VARCHAR(255),

  -- Metadata
  source INTEGER,
  category VARCHAR(255),
  sub_category VARCHAR(255),
  department VARCHAR(255),
  is_escalated BOOLEAN DEFAULT FALSE,
  workspace_name VARCHAR(100),

  -- Indexes
  INDEX idx_assigned_tech (assigned_tech_id),
  INDEX idx_created_at (created_at),
  INDEX idx_status (status),
  INDEX idx_requester (requester_id)
);
```

### Technicians Table

```sql
CREATE TABLE technicians (
  id SERIAL PRIMARY KEY,
  freshservice_id BIGINT UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  timezone VARCHAR(50) DEFAULT 'America/Los_Angeles',
  location VARCHAR(100),
  workspace_id BIGINT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  INDEX idx_freshservice_id (freshservice_id),
  INDEX idx_workspace (workspace_id)
);
```

---

## API Parameters

### Tickets Endpoint

**Endpoint**: `GET /api/v2/tickets`

**Query Parameters**:

| Parameter | Type | Required | Description | Example |
|-----------|------|----------|-------------|---------|
| `workspace_id` | Integer | No | Filter by workspace | `2` |
| `include` | String | No | Include related objects | `"requester"`, `"stats"`, `"requester,stats"` |
| `per_page` | Integer | No | Results per page (max 100) | `100` |
| `page` | Integer | No | Page number | `1` |
| `updated_since` | ISO8601 | No | Filter by update time | `"2025-10-19T10:00:00Z"` |
| `order_by` | String | No | Sort field | `"created_at"`, `"updated_at"` |
| `order_type` | String | No | Sort direction | `"asc"`, `"desc"` |

**Example Requests**:

```javascript
// Incremental sync with requester data
GET /api/v2/tickets?workspace_id=2&include=requester&per_page=100&updated_since=2025-10-19T10:00:00Z

// Full sync (last 30 days)
GET /api/v2/tickets?workspace_id=2&include=requester&per_page=100&updated_since=2025-09-19T00:00:00Z

// With stats and requester
GET /api/v2/tickets?workspace_id=2&include=requester,stats&per_page=100
```

### Agents Endpoint

**Endpoint**: `GET /api/v2/agents`

**Query Parameters**:

| Parameter | Type | Required | Description | Example |
|-----------|------|----------|-------------|---------|
| `workspace_id` | Integer | No | Filter by workspace | `2` |
| `per_page` | Integer | No | Results per page (max 100) | `100` |
| `page` | Integer | No | Page number | `1` |
| `email` | String | No | Filter by email | `"user@company.com"` |
| `state` | String | No | Filter by state | `"fulltime"`, `"occasional"` |

### Ticket Activities Endpoint

**Endpoint**: `GET /api/v2/tickets/{id}/activities`

Used to determine assignment history and self-picked status.

---

## Computed Fields

These fields are calculated by the application, not directly from FreshService:

| Field | Calculation | Purpose |
|-------|-------------|---------|
| `isSelfPicked` | Analyzes first assignment activity | Determines if tech assigned to themselves |
| `assignedBy` | Extracts actor name from assignment activity | Shows who assigned the ticket |
| `assignedTechId` | Maps `responder_id` to internal ID | Internal database reference |
| `loadLevel` | `openTicketCount < 5` = light, `5-9` = medium, `≥10` = heavy | Workload indicator |

---

## Future Enhancements

### Additional Fields to Consider

1. **Time Metrics** (computed):
   - Time to first response
   - Time to resolve
   - Time in each status
   - SLA compliance

2. **Requester Details**:
   - Phone numbers
   - Department
   - Manager information

3. **Ticket Relationships**:
   - Parent/child tickets
   - Related tickets
   - Merged tickets

4. **Collaboration**:
   - Watchers
   - CC'd users
   - Comments count

5. **Attachments**:
   - File names
   - File sizes
   - Attachment URLs

### Implementation Steps

To add new fields:

1. **Update Database Schema** (`backend/prisma/schema.prisma`):
   ```prisma
   model Ticket {
     // ... existing fields
     requesterPhone String? @db.VarChar(50) @map("requester_phone")
   }
   ```

2. **Create Migration**:
   ```bash
   cd backend
   npx prisma migrate dev --name add_requester_phone
   ```

3. **Update Transformer** (`backend/src/integrations/freshserviceTransformer.js`):
   ```javascript
   export function transformTicket(fsTicket) {
     return {
       // ... existing fields
       requesterPhone: fsTicket.requester?.phone || null,
     };
   }
   ```

4. **Update Frontend** (if displaying):
   ```jsx
   {ticket.requesterPhone && (
     <div>Phone: {ticket.requesterPhone}</div>
   )}
   ```

5. **Run Full Sync** to populate existing tickets:
   ```bash
   curl -X POST "http://localhost:3000/api/sync/trigger?fullSync=true"
   ```

---

## References

- **FreshService API Docs**: https://api.freshservice.com/v2/
- **Tickets API**: https://api.freshservice.com/v2/#tickets
- **Agents API**: https://api.freshservice.com/v2/#agents
- **Ticket Activities**: https://api.freshservice.com/v2/#ticket_activities

---

**Maintained By**: Development Team
**Last Review**: October 19, 2025
**Next Review**: When adding new fields or updating FreshService API version
