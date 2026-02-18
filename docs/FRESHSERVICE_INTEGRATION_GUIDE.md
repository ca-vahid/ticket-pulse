# FreshService Integration Guide

**For: Development Teams Integrating with FreshService**
**Last Updated**: 2026-02-16
**Status**: Production-Validated (based on Ticket Pulse production system)

This document is a comprehensive blueprint for connecting to FreshService, querying tickets, creating/updating/deleting tickets, listing agents, syncing data, and understanding the data model. All patterns described here are battle-tested in production across multiple integration teams.

---

## Table of Contents

1. [Quick Start](#1-quick-start)
2. [Authentication](#2-authentication)
3. [API Base URL & Workspace](#3-api-base-url--workspace)
4. [Core API Endpoints](#4-core-api-endpoints)
5. [Querying Tickets](#5-querying-tickets)
6. [Creating Tickets](#6-creating-tickets)
7. [Updating Tickets](#7-updating-tickets)
8. [Deleting Tickets](#8-deleting-tickets)
9. [Ticket Search & Auto-Linking (Sync Techniques)](#9-ticket-search--auto-linking-sync-techniques)
10. [Listing & Managing Agents (Technicians)](#10-listing--managing-agents-technicians)
11. [Ticket Activities & Assignment History](#11-ticket-activities--assignment-history)
12. [Requesters (End Users)](#12-requesters-end-users)
13. [CSAT (Customer Satisfaction)](#13-csat-customer-satisfaction)
14. [Custom Fields - CRITICAL](#14-custom-fields---critical)
15. [Field Mappings & Data Model](#15-field-mappings--data-model)
16. [Status & Priority Codes](#16-status--priority-codes)
17. [Source Codes](#17-source-codes)
18. [Rate Limiting & Retry Logic](#18-rate-limiting--retry-logic)
19. [Pagination](#19-pagination)
20. [Known Limitations & Gotchas](#20-known-limitations--gotchas)
21. [Code Examples](#21-code-examples)
22. [Environment Setup](#22-environment-setup)
23. [Appendix: Full Ticket Object Reference](#appendix-full-ticket-object-reference)

---

## 1. Quick Start

### Minimum Requirements to Connect

```
Domain:      efusion.freshservice.com
API Version: v2
Auth:        Basic Auth (API key as username, "X" as password)
Base URL:    https://efusion.freshservice.com/api/v2
Workspace:   See Section 3 for workspace ID details
```

### Simplest Possible Request (curl)

```bash
# List first page of tickets
curl -u "YOUR_API_KEY:X" \
  "https://efusion.freshservice.com/api/v2/tickets?per_page=10"

# List agents
curl -u "YOUR_API_KEY:X" \
  "https://efusion.freshservice.com/api/v2/agents?per_page=10"
```

### Simplest Possible Request (JavaScript/Node.js)

```javascript
import axios from 'axios';

const client = axios.create({
  baseURL: 'https://efusion.freshservice.com/api/v2',
  headers: { 'Content-Type': 'application/json' },
  auth: {
    username: 'YOUR_FRESHSERVICE_API_KEY',
    password: 'X', // Always "X" - FreshService ignores the password
  },
  timeout: 30000,
});

// Fetch tickets
const { data } = await client.get('/tickets', { params: { per_page: 100 } });
console.log(data.tickets); // Array of ticket objects
```

---

## 2. Authentication

### How It Works

FreshService uses **HTTP Basic Authentication** with the API key as the username. The password is ignored but must be present (use `"X"` by convention).

```
Authorization: Basic base64(API_KEY:X)
```

### Getting an API Key

1. Log in to `https://efusion.freshservice.com` as an admin
2. Navigate to **Profile Settings** (click avatar top-right)
3. Your API key is displayed on the right sidebar
4. **Important**: Each agent has their own API key. Use a service account API key for application integrations

### Authentication in Code

```javascript
// Using Axios (recommended)
const client = axios.create({
  baseURL: 'https://efusion.freshservice.com/api/v2',
  auth: {
    username: API_KEY,
    password: 'X',  // FreshService uses API key as username, password can be anything
  },
});

// Using fetch
const headers = new Headers();
headers.set('Authorization', 'Basic ' + btoa(API_KEY + ':X'));
headers.set('Content-Type', 'application/json');

const response = await fetch('https://efusion.freshservice.com/api/v2/tickets', { headers });
```

### Testing Your Connection

```javascript
// Quick connection test - fetch 1 agent
const response = await client.get('/agents', { params: { per_page: 1 } });
// If this returns 200, your API key is valid
```

### Environment Variables

Store credentials securely. Never hardcode API keys.

```env
FRESHSERVICE_API_KEY=your-api-key-here
FRESHSERVICE_DOMAIN=efusion.freshservice.com
FRESHSERVICE_WORKSPACE_ID=3    # IT workspace - see Section 3
```

---

## 3. API Base URL & Workspace

### Base URL

```
https://efusion.freshservice.com/api/v2
```

The domain handles both formats:
- Full domain: `efusion.freshservice.com`
- Subdomain only: `efusion` (resolved to `efusion.freshservice.com` by prepending)

### Workspace ID for IT

**The IT workspace ID is configured via the `FRESHSERVICE_WORKSPACE_ID` environment variable.** This is set in the application settings and stored in the `app_settings` database table under the key `freshservice_workspace_id`.

FreshService supports multiple workspaces. Our organization uses workspaces to separate departments. The workspace ID is critical for:

1. **Filtering agents** to only IT technicians (not HR, Facilities, etc.)
2. **Filtering tickets** to only IT tickets
3. **Determining which agents are "active" in IT context**

### How Workspace Filtering Works

When fetching agents, pass `workspace_id` as a query parameter:

```javascript
// Fetch only agents in the IT workspace
const response = await client.get('/agents', {
  params: {
    workspace_id: WORKSPACE_ID,  // Your IT workspace ID
    per_page: 100,
  },
});
```

Each agent in FreshService has a `workspace_ids` array listing all workspaces they belong to. Our system uses this to filter:

```javascript
// Server-side filtering after fetch (defense in depth)
const itAgents = allAgents.filter(agent => {
  return agent.workspace_ids && agent.workspace_ids.includes(Number(WORKSPACE_ID));
});
```

### Agents Not in IT Workspace

Agents not belonging to the IT workspace are **automatically deactivated** in our system. This means:
- They still exist in FreshService globally
- They won't appear in IT-specific views
- Their `isActive` flag is set to `false`

---

## 4. Core API Endpoints

### Endpoint Reference

| Endpoint | Method | Purpose | Pagination | Auth Required |
|----------|--------|---------|------------|---------------|
| `/tickets` | GET | List all tickets | Yes (100/page) | Yes |
| `/tickets/{id}` | GET | Get single ticket | No | Yes |
| `/tickets` | POST | Create a ticket | No | Yes |
| `/tickets/{id}` | PUT | Update a ticket | No | Yes |
| `/tickets/{id}` | DELETE | Delete a ticket | No | Yes |
| `/tickets/{id}/activities` | GET | Get ticket activities | Yes (100/page) | Yes |
| `/tickets/{id}/csat_response` | GET | Get CSAT survey response | No | Yes |
| `/tickets/{id}/time_entries` | GET | Get time entries | Yes | Yes |
| `/agents` | GET | List all agents | Yes (100/page) | Yes |
| `/agents/{id}` | GET | Get single agent | No | Yes |
| `/requesters` | GET | List requesters | Yes (100/page) | Yes |
| `/requesters/{id}` | GET | Get single requester | No | Yes |
| `/ticket_form_fields` | GET | Get form field definitions (for discovering custom fields & categories) | No | Yes |

### Common Query Parameters (GET /tickets)

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `per_page` | int | Results per page (max 100) | `100` |
| `page` | int | Page number (1-based) | `1` |
| `updated_since` | ISO 8601 | Tickets updated after this date | `2025-01-01T00:00:00Z` |
| `include` | string | Include related objects | `requester,stats` |
| `workspace_id` | int | Filter by workspace | `3` |
| `filter` | string | Pre-defined filter | `status:2` (Open) |
| `order_by` | string | Sort field | `created_at` |
| `order_type` | string | Sort direction | `desc` |

---

## 5. Querying Tickets

### Fetch All Tickets (Paginated)

FreshService returns a **maximum of 100 tickets per page**. You must paginate to get all tickets.

```javascript
async function fetchAllTickets(params = {}) {
  const allTickets = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const response = await client.get('/tickets', {
      params: {
        ...params,
        page,
        per_page: 100,  // Maximum allowed
      },
    });

    const tickets = response.data.tickets || [];
    allTickets.push(...tickets);

    // FreshService returns fewer results on the last page
    if (tickets.length < 100) {
      hasMore = false;
    } else {
      page++;
    }

    // IMPORTANT: Rate limiting - wait 1 second between pages
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  return allTickets;
}
```

### Fetch Tickets Updated Since a Date

```javascript
const tickets = await fetchAllTickets({
  updated_since: '2025-10-01T00:00:00Z',
  include: 'requester,stats',  // Include requester details and resolution stats
});
```

> **WARNING**: The `updated_since` parameter returns ALL tickets updated since that date. There is **no `updated_before` or date range filter**. You must filter client-side. See [Section 20: Known Limitations](#20-known-limitations--gotchas).

### Fetch a Single Ticket

```javascript
const response = await client.get(`/tickets/${ticketId}`);
const ticket = response.data.ticket;
```

### Fetch Tickets with Requester & Stats

Always use `include=requester,stats` to get the requester name/email and resolution time metrics in a single call:

```javascript
const response = await client.get('/tickets', {
  params: {
    per_page: 100,
    include: 'requester,stats',  // Adds requester object and stats object to each ticket
  },
});

// Each ticket now has:
// ticket.requester.name, ticket.requester.email
// ticket.stats.resolution_time_in_secs
```

### Filter Tickets by Status

FreshService uses numeric status codes (not strings):

```javascript
// Get only open tickets
const response = await client.get('/tickets', {
  params: {
    filter: 'status:2',  // 2 = Open
    per_page: 100,
  },
});
```

---

## 6. Creating Tickets

### Create a Basic Ticket

```javascript
const response = await client.post('/tickets', {
  subject: 'Laptop not connecting to WiFi',
  description: '<p>My laptop cannot connect to the office WiFi since this morning.</p>',
  email: 'john.doe@company.com',  // Requester's email
  priority: 2,                     // 1=Low, 2=Medium, 3=High, 4=Urgent
  status: 2,                       // 2=Open
  // workspace_id: 3,              // Optional: specify workspace
});

const newTicket = response.data.ticket;
console.log(`Created ticket #${newTicket.id}`);
```

### Create a Ticket with Custom Fields

```javascript
const response = await client.post('/tickets', {
  subject: 'VPN Access Request',
  description: '<p>Need VPN access for remote work.</p>',
  email: 'jane.smith@company.com',
  priority: 1,  // Low
  status: 2,    // Open
  custom_fields: {
    security: 'BST',  // This is the "ticket category" field - see Section 14
  },
});
```

### Create a Ticket Assigned to a Specific Agent

```javascript
const response = await client.post('/tickets', {
  subject: 'New Employee Setup - John Doe',
  description: '<p>Please set up workstation for new hire starting Monday.</p>',
  email: 'hr@company.com',
  priority: 2,
  status: 2,
  responder_id: 21000123456,  // FreshService agent ID
});
```

### Required vs Optional Fields for Ticket Creation

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `subject` | Yes | string | Ticket subject line |
| `description` | Yes | string | HTML body of the ticket |
| `email` | Yes* | string | Requester email (*or `requester_id`) |
| `requester_id` | Yes* | number | Requester ID (*or `email`) |
| `priority` | No | number | 1=Low, 2=Medium, 3=High, 4=Urgent (default: 1) |
| `status` | No | number | 2=Open, 3=Pending, etc. (default: 2) |
| `responder_id` | No | number | Agent to assign the ticket to |
| `category` | No | string | FreshService built-in category |
| `sub_category` | No | string | FreshService built-in sub-category |
| `custom_fields` | No | object | Custom field values (see Section 14) |
| `workspace_id` | No | number | Workspace to create ticket in |
| `source` | No | number | 1=Email, 2=Portal, 3=Phone, etc. (see Section 17) |
| `due_by` | No | string (ISO 8601) | Ticket due date (**must be in the future**) |
| `fr_due_by` | No | string (ISO 8601) | First response due date (**must be in the future**) |
| `tags` | No | string[] | Array of tag strings (e.g., `['ISO-2025']`) |

### Due Date Handling - Important

FreshService **rejects past dates** for `due_by` and `fr_due_by`. If you send a date in the past, the API returns HTTP 400.

**Best practice**: Validate dates before sending and silently drop past dates:

```javascript
function buildTicketPayload(data) {
  const payload = {
    subject: data.subject,
    description: data.description,
    email: data.requesterEmail,
    priority: data.priority || 2,
    status: 2,
  };

  // Only include due dates if they are in the future
  if (data.dueDate) {
    const dueDate = new Date(data.dueDate);
    if (dueDate > new Date()) {
      payload.due_by = dueDate.toISOString();
      payload.fr_due_by = dueDate.toISOString(); // Often set to same value
    }
    // Past dates are silently dropped - ticket created without due date
  }

  return payload;
}
```

> **Warning**: If a task has a due date but it's in the past, the ticket will be created **without a due date**. This can be confusing because the source record appears to have a due date but the FreshService ticket does not.

### Agent Resolution for Assignment

When creating a ticket and assigning it to an agent, you need the agent's FreshService numeric ID for the `responder_id` field. Common patterns:

```javascript
// If you store the FreshService agent ID locally
const agentId = parseInt(technician.agentId, 10);  // Must be a valid integer

if (!isNaN(agentId)) {
  payload.responder_id = agentId;
} else {
  // Ticket will be created without an assignee (unassigned)
  console.warn(`Invalid agent ID for technician ${technician.id}`);
}
```

> **Soft failure**: If `responder_id` is omitted or invalid, the ticket is still created -- just without an assignee. This is a soft failure, not a hard error (unless the ID points to a deactivated agent, which returns 400).

### Why Ticket Creation Might Fail

Here is a comprehensive list of failure scenarios discovered through production usage:

#### Configuration Failures (HTTP 500 from your server)

| Cause | Error | Resolution |
|---|---|---|
| API key not configured | Server returns 500 before calling FreshService | Set `FRESHSERVICE_API_KEY` env variable |
| Domain not configured | Server returns 500 before calling FreshService | Set `FRESHSERVICE_DOMAIN` env variable |

#### Validation Failures (HTTP 400)

| Cause | FreshService Response | Resolution |
|---|---|---|
| Missing `description` | 400 Bad Request | Ensure the ticket has an HTML description body |
| Missing `subject` | 400 Bad Request | Ensure the ticket has a subject line |
| Missing `email` AND `requester_id` | 400 Bad Request | Provide at least one requester identifier |
| `email` not registered in FreshService | 400 Bad Request | The requester email must exist in FreshService, or FreshService must be configured to auto-create requesters |
| Invalid `due_by` format | 400 Bad Request | Must be ISO 8601 format |
| `due_by` is in the past | 400 Bad Request | FreshService rejects past due dates |
| Invalid `custom_fields` values | 400 Bad Request | Category value must match allowed choices in FreshService form config |
| Invalid `responder_id` | 400 Bad Request | Agent ID doesn't exist or agent is deactivated in FreshService |
| `workspace_id` doesn't exist | 400/404 | Workspace may have been deleted or ID changed |

#### Authentication & API Errors

| Cause | HTTP Code | Notes |
|---|---|---|
| Invalid or expired API token | 401 Unauthorized | Token may have been revoked. Obtain a new one from FreshService admin panel |
| Rate limiting | 429 Too Many Requests | Implement retry with exponential backoff (see Section 18) |
| FreshService downtime | 5xx | Service temporarily unavailable. Implement retry logic |
| Network timeout | N/A | Set client timeout to at least 30 seconds |
| DNS resolution failure | N/A | Check network connectivity and domain configuration |

#### Soft Failures (Ticket Created, But Incomplete)

These do **not** prevent ticket creation. The ticket is created but missing some data:

| Cause | Effect |
|---|---|
| `responder_id` not provided or technician lookup fails | Ticket created **without an assignee** |
| `due_by` is in the past (if you silently drop it) | Ticket created **without a due date** |
| `custom_fields.security` value not in allowed choices | Depends on FreshService config -- may reject or accept |

### Post-Creation: Storing the Ticket Reference

After creating a ticket, always store the FreshService ticket ID and construct the ticket URL for linking:

```javascript
const response = await client.post('/tickets', payload);
const ticket = response.data.ticket;

// Store these for future reference
const ticketId = ticket.id;                      // e.g., 12345
const ticketUrl = `https://${FRESHSERVICE_DOMAIN}/a/tickets/${ticketId}`;

// Save to your database/store
await updateLocalRecord({
  ticketNumber: String(ticketId),
  ticketUrl: ticketUrl,
});
```

> **Note**: The ticket URL format is `https://{DOMAIN}/a/tickets/{id}`. The `/a/` prefix is for the agent portal. Derive this from your `FRESHSERVICE_DOMAIN` config rather than hardcoding the domain.

---

## 7. Updating Tickets

### Basic Ticket Update

Use `PUT /api/v2/tickets/{id}` to update any ticket field. Only include the fields you want to change -- FreshService performs a partial update.

```javascript
// Update status and priority
const response = await client.put(`/tickets/${ticketId}`, {
  status: 4,     // Resolved
  priority: 3,   // High
});

const updatedTicket = response.data.ticket;
```

### Update Assignment (Reassign Ticket)

```javascript
// Reassign to a different agent
await client.put(`/tickets/${ticketId}`, {
  responder_id: 21000654321,  // New agent's FreshService ID
});

// Unassign (remove assignee)
await client.put(`/tickets/${ticketId}`, {
  responder_id: null,
});
```

### Update Custom Fields

```javascript
await client.put(`/tickets/${ticketId}`, {
  custom_fields: {
    security: 'GIS',  // Change our ticket category
  },
});
```

### Update Due Date

```javascript
// Set/change due date (must be in the future)
await client.put(`/tickets/${ticketId}`, {
  due_by: '2026-03-15T17:00:00Z',
  fr_due_by: '2026-03-14T12:00:00Z',
});
```

> **Warning**: Same rule as creation -- `due_by` and `fr_due_by` must be in the future or FreshService returns 400.

### Update Tags

```javascript
// Replace all tags
await client.put(`/tickets/${ticketId}`, {
  tags: ['urgent', 'ISO-2025', 'escalated'],
});
```

### Bulk Updates (Workaround)

FreshService has **no bulk update endpoint**. To update multiple tickets, you must loop with rate limiting:

```javascript
async function bulkUpdateTickets(ticketUpdates) {
  const results = [];

  for (const { ticketId, data } of ticketUpdates) {
    try {
      const response = await client.put(`/tickets/${ticketId}`, data);
      results.push({ ticketId, success: true, ticket: response.data.ticket });
    } catch (error) {
      results.push({ ticketId, success: false, error: error.message });
    }

    // Rate limiting: 1 second between updates
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  return results;
}
```

### Update Failure Modes

| Cause | HTTP Code | Notes |
|---|---|---|
| Ticket ID doesn't exist | 404 | Verify the ticket ID before updating |
| Invalid `responder_id` | 400 | Agent must exist and be active |
| `due_by` in the past | 400 | Must be a future date |
| Invalid status transition | 400 | Some status changes may be restricted by workflow rules |
| Invalid `custom_fields` values | 400 | Values must match configured choices |
| Ticket is in a closed/archived state | 400/403 | Some updates may be blocked on closed tickets depending on FreshService config |

### Syncing Existing Tickets (Upsert Pattern)

When syncing data from an external system to FreshService, use an **upsert pattern**: check if a ticket already exists, then create or update accordingly.

```javascript
async function syncTicketToFreshService(localRecord) {
  // Check if ticket already exists in FreshService
  if (localRecord.ticketNumber) {
    // Update existing ticket
    try {
      const response = await client.put(`/tickets/${localRecord.ticketNumber}`, {
        status: mapStatus(localRecord.status),
        priority: mapPriority(localRecord.priority),
        custom_fields: {
          security: localRecord.category,
        },
      });
      return { action: 'updated', ticket: response.data.ticket };
    } catch (error) {
      if (error.response?.status === 404) {
        // Ticket was deleted from FreshService - clear local reference and recreate
        localRecord.ticketNumber = null;
      } else {
        throw error;
      }
    }
  }

  // Create new ticket
  const response = await client.post('/tickets', {
    subject: localRecord.title,
    description: localRecord.description,
    email: localRecord.requesterEmail,
    priority: mapPriority(localRecord.priority),
    status: 2,  // Open
  });

  // Store reference for future syncs
  localRecord.ticketNumber = String(response.data.ticket.id);
  return { action: 'created', ticket: response.data.ticket };
}
```

---

## 8. Deleting Tickets

### Delete a Ticket

```javascript
const response = await client.delete(`/tickets/${ticketId}`);
// Returns 204 No Content on success
```

### Deletion Strategies

There are two common approaches when "removing" a ticket link:

#### Hard Delete (Remove from FreshService)

```javascript
async function deleteTicket(ticketId) {
  try {
    await client.delete(`/tickets/${ticketId}`);
    // Clean up local reference
    await clearLocalTicketReference(ticketId);
    return { success: true };
  } catch (error) {
    // If 404, ticket was already deleted
    if (error.response?.status === 404) {
      await clearLocalTicketReference(ticketId);
      return { success: true, note: 'Ticket already deleted' };
    }
    throw error;
  }
}
```

#### Soft Unlink (Keep in FreshService, Remove Local Reference)

```javascript
async function unlinkTicket(localRecordId) {
  // Just clear the local reference without touching FreshService
  await updateLocalRecord(localRecordId, {
    ticketNumber: null,
    ticketUrl: null,
  });
  return { success: true };
}
```

### Deletion Error Handling Strategies

Two approaches exist in production, each with trade-offs:

| Strategy | Behavior on FreshService DELETE Failure | Use When |
|---|---|---|
| **Strict** | Keep local ticket reference intact (don't clear) | Data integrity is paramount; you want to retry later |
| **Resilient** | Clear local reference regardless of remote result | User experience is priority; always clean up locally |

> **Recommendation**: The resilient approach is generally safer. If the FreshService delete fails, the ticket still exists remotely but at least your local state is clean. You can always re-link later if needed.

### Deletion Limitations

- **No bulk delete endpoint** -- must delete one ticket at a time with rate limiting
- **Permanently deleted** -- FreshService DELETE is a hard delete (not soft delete/trash). The ticket cannot be recovered
- **Cascading effects** -- Deleting a ticket also removes its activities, time entries, and CSAT responses

---

## 9. Ticket Search & Auto-Linking (Sync Techniques)

### Overview

If your application creates tickets in FreshService, you may need to detect tickets that already exist to avoid duplicates or to re-link orphaned references.

### Subject-Based Search (Simple but Limited)

The simplest approach is to fetch tickets and match by subject:

```javascript
async function findTicketBySubject(subject) {
  const response = await client.get('/tickets', {
    params: { per_page: 100 },
  });

  const tickets = response.data.tickets || [];
  return tickets.find(
    t => t.subject.toLowerCase() === subject.toLowerCase()
  );
}
```

**Limitations of subject-based matching:**

| Limitation | Impact |
|---|---|
| Only searches default first page of results | Older tickets won't be found |
| Exact match only (case-insensitive) | Similar but not identical subjects won't match |
| No pagination | Large ticket volumes have incomplete coverage |
| Subject changes break the link | Renamed tickets/tasks won't match |

### FreshService Filter API (Better)

FreshService supports a filter query language for more precise searches:

```javascript
// Search by specific filter criteria
const response = await client.get('/tickets', {
  params: {
    per_page: 100,
    filter: "subject:'VPN Access Request'",
    // Also supports: status, priority, agent_id, created_at, etc.
  },
});
```

### Recommended: ID-Based Linking

The most reliable sync pattern is to **store the FreshService ticket ID** as the canonical reference, then use it for all lookups:

```javascript
async function getLinkedTicket(freshserviceTicketId) {
  try {
    const response = await client.get(`/tickets/${freshserviceTicketId}`);
    return response.data.ticket;
  } catch (error) {
    if (error.response?.status === 404) {
      return null;  // Ticket was deleted from FreshService
    }
    throw error;
  }
}
```

### Sync Direction Strategies

| Strategy | Description | Complexity | Use Case |
|---|---|---|---|
| **One-way push** | Create/update tickets in FreshService from your app | Low | Your app is the source of truth |
| **One-way pull** | Read tickets from FreshService into your app (our current approach) | Medium | FreshService is the source of truth |
| **Bidirectional** | Changes sync both ways | High | Both systems need to stay in sync |

### One-Way Pull Sync (Polling Pattern)

This is the approach used by Ticket Pulse. A scheduled job polls FreshService for changes:

```javascript
// Run every 30 seconds via cron
async function incrementalSync() {
  // Get last successful sync timestamp
  const lastSync = await getLastSyncTime();

  // Fetch tickets updated since last sync (with 5-min buffer)
  const buffer = 5 * 60 * 1000; // 5 minutes
  const updatedSince = new Date(lastSync.getTime() - buffer).toISOString();

  const tickets = await client.getTickets({
    updated_since: updatedSince,
    include: 'requester,stats',
  });

  // Upsert each ticket to local database
  for (const ticket of tickets) {
    await upsertLocalTicket(transformTicket(ticket));
  }

  await saveLastSyncTime(new Date());
}
```

### Bidirectional Sync Considerations

If you need changes from FreshService to flow back to your app, consider:

1. **FreshService Webhooks** -- Register webhooks for ticket create/update/delete events (preferred for real-time)
2. **Polling** -- Scheduled job queries FreshService for recently updated tickets (simpler but not real-time)
3. **SSE (Server-Sent Events)** -- Our approach: backend broadcasts changes to connected frontends after each sync

### Session-Based Deduplication

To avoid redundant API calls when checking for existing tickets, use session-based caching:

```javascript
// Frontend: Check once per session per record
function shouldCheckForTicket(recordId) {
  const key = `ticket-checked-${recordId}`;
  if (sessionStorage.getItem(key)) return false;
  sessionStorage.setItem(key, 'true');
  return true;
}
```

### Sync Limitations Summary

| Limitation | Impact | Mitigation |
|---|---|---|
| No bidirectional sync by default | FreshService changes (status, reassignment, closure) not reflected in your app | Implement webhooks or polling |
| No webhook integration by default | Real-time sync requires setup | Configure FreshService webhooks |
| `updated_since` returns all tickets after date | Overfetching for date-range queries | Client-side date filtering |
| No bulk activity endpoints | Slow activity analysis | Batch with concurrency control |
| Rate limiting on writes | Can't bulk-create/update fast | Sequential processing with 1s delays |

---

## 10. Listing & Managing Agents (Technicians)

### Fetch All IT Agents

```javascript
// Fetch agents filtered by workspace
const response = await client.get('/agents', {
  params: {
    workspace_id: WORKSPACE_ID,  // Your IT workspace ID
    per_page: 100,
  },
});

const agents = response.data.agents;
```

### Agent Object Structure

```json
{
  "id": 21000123456,
  "first_name": "John",
  "last_name": "Doe",
  "email": "john.doe@company.com",
  "active": true,
  "time_zone": "America/Los_Angeles",
  "workspace_ids": [2, 3, 5],
  "role_ids": [21000001],
  "department_ids": [],
  "created_at": "2023-01-15T08:30:00Z",
  "updated_at": "2025-09-20T14:15:00Z"
}
```

### Determining Active vs Inactive Agents

FreshService agents have an `active` boolean field:

```javascript
// From FreshService API response
const isActive = agent.active;  // true or false
```

Our system determines "active in IT" using two criteria:

1. **`agent.active === true`** in FreshService (account not deactivated)
2. **Agent belongs to the IT workspace** (`agent.workspace_ids.includes(WORKSPACE_ID)`)

```javascript
function isActiveITAgent(agent, workspaceId) {
  const isAccountActive = agent.active !== undefined ? agent.active : true;
  const isInITWorkspace = agent.workspace_ids &&
    agent.workspace_ids.includes(Number(workspaceId));
  return isAccountActive && isInITWorkspace;
}
```

### Agent Fields We Track

| FreshService Field | Our Database Field | Notes |
|---|---|---|
| `id` | `freshserviceId` (BigInt) | Unique FreshService agent ID |
| `first_name` + `last_name` | `name` | Concatenated: `"John Doe"` |
| `email` | `email` | Agent's email address |
| `active` | `isActive` | Boolean, combined with workspace check |
| `time_zone` | `timezone` | Default: `America/Los_Angeles` |
| `workspace_ids[0]` | `workspaceId` | First workspace or provided workspace ID |

### Agent Deactivation Logic

When syncing agents, our system automatically deactivates agents who:
- Have `active: false` in FreshService
- Do NOT belong to the configured IT workspace
- Have `null` workspace ID

```javascript
// Deactivate agents not in the IT workspace
await prisma.technician.updateMany({
  where: {
    OR: [
      { workspaceId: null },
      { workspaceId: { not: BigInt(workspaceId) } },
    ],
    isActive: true,
  },
  data: {
    isActive: false,
  },
});
```

---

## 11. Ticket Activities & Assignment History

### What Are Activities?

Ticket activities are the audit log of everything that happened on a ticket:
- Agent assignments (who assigned the ticket and to whom)
- Status changes
- Replies (public and private)
- Notes added
- Priority changes

### Fetching Activities for a Ticket

```javascript
const response = await client.get(`/tickets/${ticketId}/activities`);
const activities = response.data.activities || [];
```

> **CRITICAL LIMITATION**: There is **no bulk activity endpoint**. You must call `/tickets/{id}/activities` for **each ticket individually**. For 300 tickets, that's 300 separate API calls. This is the biggest performance bottleneck.

### Activity Object Structure

```json
{
  "created_at": "2025-10-15T09:30:00Z",
  "content": " set Agent as John Doe",
  "actor": {
    "id": 21000123456,
    "name": "Jane Smith"
  },
  "incoming": false,
  "private": false,
  "body_text": "...",
  "body": "<p>...</p>"
}
```

### Detecting Self-Picked vs Coordinator-Assigned Tickets

This is a key business logic pattern. When an agent assigns a ticket to themselves, it's "self-picked." When a coordinator assigns it to someone else, it's "coordinator-assigned."

**Detection Algorithm:**

```javascript
function analyzeTicketActivities(activities) {
  // Sort by date (oldest first)
  const sorted = [...activities].sort(
    (a, b) => new Date(a.created_at) - new Date(b.created_at)
  );

  for (const activity of sorted) {
    // Look for assignment activities
    // FreshService format: " set Agent as [Agent Name]"
    if (activity.content && activity.content.includes('set Agent as')) {
      const match = activity.content.match(/set Agent as (.+)/);

      if (match) {
        const assignedAgentName = match[1].trim();  // Who was assigned
        const actorName = activity.actor?.name;       // Who did the assigning

        // Self-picked = actor is the same person as the assigned agent
        const isSelfPicked = (actorName === assignedAgentName);

        return {
          isSelfPicked,
          assignedBy: isSelfPicked ? null : actorName,
          firstAssignedAt: new Date(activity.created_at),
        };
      }
    }
  }

  return { isSelfPicked: false, assignedBy: null, firstAssignedAt: null };
}
```

**Key Pattern**: The `content` field uses the format `" set Agent as [Agent Name]"`. The `actor.name` tells you who performed the action. If `actor.name === assignedAgentName`, the ticket was self-picked.

### Detecting First Public Agent Reply

```javascript
function findFirstPublicReply(activities) {
  const sorted = [...activities].sort(
    (a, b) => new Date(a.created_at) - new Date(b.created_at)
  );

  for (const activity of sorted) {
    const isIncoming = activity.incoming === true;     // Customer message
    const isPrivate = activity.private === true;        // Internal note
    const hasBody = (activity.body_text?.trim().length > 0) ||
                    (activity.body?.trim().length > 0);

    // First outgoing, public message with content = first agent reply
    if (!isIncoming && !isPrivate && hasBody) {
      return new Date(activity.created_at);
    }
  }

  return null;
}
```

---

## 12. Requesters (End Users)

### What Are Requesters?

Requesters are the end users who submit tickets (employees, customers, etc.). They are different from agents (IT technicians).

### Fetch a Single Requester

```javascript
const response = await client.get(`/requesters/${requesterId}`);
const requester = response.data.requester;
```

### Requester Object Structure

```json
{
  "id": 21000654321,
  "first_name": "Alice",
  "last_name": "Johnson",
  "email": "alice.johnson@company.com",
  "phone": "+1-555-0100",
  "mobile": "+1-555-0101",
  "department": { "name": "Marketing" },
  "job_title": "Marketing Manager",
  "time_zone": "America/New_York",
  "language": "en",
  "active": true,
  "created_at": "2024-03-10T12:00:00Z",
  "updated_at": "2025-08-15T09:30:00Z"
}
```

### Requester Info on Tickets

When you use `include=requester` on the tickets endpoint, each ticket includes a nested requester object:

```javascript
const response = await client.get('/tickets', {
  params: {
    per_page: 100,
    include: 'requester',
  },
});

// Each ticket has:
// ticket.requester_id  → FreshService requester ID
// ticket.requester     → { name, email, ... } (when include=requester)
```

> **Note**: There is no bulk requester endpoint. To fetch details for multiple requesters, you must call `/requesters/{id}` individually with rate limiting (we use 1.1s delay between requests).

---

## 13. CSAT (Customer Satisfaction)

### Fetching CSAT for a Ticket

CSAT responses are only available for closed/resolved tickets where the customer completed a survey.

```javascript
const response = await client.get(`/tickets/${ticketId}/csat_response`);
const csatResponse = response.data.csat_response;

// Returns null/404 if no CSAT survey was submitted
```

### CSAT Response Object

```json
{
  "id": 12345,
  "score": {
    "acquired_score": 3,
    "total_score": 4
  },
  "overall_rating": 301,
  "overall_rating_text": "Good",
  "questionnaire_responses": [
    {
      "question": {
        "question_text": "How would you rate your experience?"
      },
      "answers": [
        { "answer_text": "Good" }
      ]
    },
    {
      "question": {
        "question_text": "Any additional feedback?"
      },
      "answers": [
        { "answer_text": "Quick response, thanks!" }
      ]
    }
  ],
  "created_at": "2025-10-20T14:30:00Z"
}
```

### CSAT Score Interpretation

| Score | Rating Text | Meaning |
|-------|------------|---------|
| 1 | Poor | Very unsatisfied |
| 2 | Fair | Somewhat unsatisfied |
| 3 | Good | Satisfied |
| 4 | Excellent | Very satisfied |

---

## 14. Custom Fields - CRITICAL

### The "Category" Trap

**This is one of the most important things to know.** What we display as "ticket category" in our dashboard (values like **BST**, **GIS**, **Network**, etc.) is **NOT** the built-in FreshService `category` field. It is a **custom field** called `security`.

### Field Mapping

| What We Call It | FreshService Built-in Field | FreshService Custom Field | API Path |
|---|---|---|---|
| Category (built-in) | `ticket.category` | - | `ticket.category` |
| Sub-category (built-in) | `ticket.sub_category` | - | `ticket.sub_category` |
| **Ticket Category (ours)** | - | **`security`** | **`ticket.custom_fields.security`** |

### How to Access Custom Fields

Custom fields are nested inside the `custom_fields` object on the ticket:

```javascript
const ticket = response.data.ticket;

// Built-in category (FreshService standard field)
const builtInCategory = ticket.category;        // e.g., "Hardware"
const builtInSubCategory = ticket.sub_category; // e.g., "Laptop"

// OUR ticket category (custom field named "security")
const ticketCategory = ticket.custom_fields?.security;  // e.g., "BST", "GIS", "Network"
```

### Why "security"?

The custom field was named `security` in FreshService's admin configuration. Despite the misleading name, it contains the IT operational category (BST, GIS, Network, etc.), not security-related data. This is just how the field was originally set up in FreshService.

### Discovering Custom Fields via the Form Fields API

To discover all custom fields configured in your FreshService instance, use the ticket form fields endpoint:

```bash
curl -u "YOUR_API_KEY:X" \
  "https://efusion.freshservice.com/api/v2/ticket_form_fields"
```

This returns all fields on the ticket form, including both built-in and custom fields. To find the "Category" custom field programmatically:

```javascript
const response = await client.get('/ticket_form_fields');
const fields = response.data.ticket_fields || [];

// Find the Category custom field
// Known field ID in our instance: 1000158814
const categoryField = fields.find(
  f => f.id === 1000158814 || f.label === 'Category'
);

if (categoryField) {
  // Extract available choices
  const choices = categoryField.choices.map(choice => ({
    id: String(choice.id),
    value: choice.value,       // This is what gets sent as custom_fields.security
    displayId: choice.id,
  }));

  console.log('Available categories:', choices);
  // e.g., [{ id: "1", value: "BST" }, { id: "2", value: "GIS" }, ...]
}
```

> **Important**: The category field ID (`1000158814`) is specific to our FreshService instance. If the FreshService form configuration is modified, this ID may change. Always verify the field ID by label as a fallback.

### Category Values Sent to API

When setting the category on a ticket, send the **display value** (e.g., `"BST"`, `"GIS"`, `"Network"`) as `custom_fields.security`, **not** the choice ID:

```javascript
// Correct: send the value string
custom_fields: { security: 'BST' }

// Incorrect: don't send the choice ID
custom_fields: { security: 12345 }  // This will fail
```

### Setting Custom Fields When Creating/Updating Tickets

```javascript
// Creating a ticket with custom fields
await client.post('/tickets', {
  subject: 'Network outage in Building A',
  description: '<p>The network is down in Building A, 3rd floor.</p>',
  email: 'user@company.com',
  priority: 3,  // High
  status: 2,    // Open
  custom_fields: {
    security: 'Network',  // Our "ticket category"
    // ... other custom fields as needed
  },
});

// Updating custom fields on an existing ticket
await client.put(`/tickets/${ticketId}`, {
  custom_fields: {
    security: 'BST',
  },
});
```

---

## 15. Field Mappings & Data Model

### Complete Ticket Field Mapping

This table maps every FreshService API field to our internal database schema.

| FreshService API Field | Our DB Column | Type | Notes |
|---|---|---|---|
| `id` | `freshservice_ticket_id` | BigInt | Unique ticket identifier |
| `subject` | `subject` | Text | Ticket subject line |
| `description` | `description` | Text | HTML description |
| `description_text` | `description_text` | Text | Plain text version |
| `status` | `status` | VarChar(50) | Mapped from numeric (see Section 16) |
| `priority` | `priority` | Int | 1-4, direct mapping |
| `responder_id` | `assigned_tech_id` (via mapping) | Int | Mapped from FS agent ID to internal ID |
| `requester_id` | `requester_freshservice_id` | BigInt | FreshService requester ID |
| `requester.name` | `requester_name` (via relation) | VarChar | From `include=requester` |
| `requester.email` | `requester_email` (via relation) | VarChar | From `include=requester` |
| `created_at` | `created_at` | DateTime | Ticket creation timestamp |
| `updated_at` | `updated_at` | DateTime | Last update timestamp |
| `assigned_at` | `assigned_at` | DateTime | When ticket was assigned (FreshService field) |
| `resolved_at` | `resolved_at` | DateTime | When ticket was resolved |
| `closed_at` | `closed_at` | DateTime | When ticket was closed |
| `due_by` | `due_by` | DateTime | SLA due date |
| `fr_due_by` | `fr_due_by` | DateTime | First response due date |
| `source` | `source` | Int | Source code (see Section 17) |
| `category` | `category` | VarChar(255) | FreshService built-in category |
| `sub_category` | `sub_category` | VarChar(255) | FreshService built-in sub-category |
| **`custom_fields.security`** | **`ticket_category`** | **VarChar(100)** | **Custom field - our operational category (BST, GIS, etc.)** |
| `department.name` | `department` | VarChar(255) | Requester's department |
| `is_escalated` | `is_escalated` | Boolean | Whether ticket is escalated |
| `stats.resolution_time_in_secs` | `resolution_time_seconds` | Int | Time to resolution (requires `include=stats`) |
| *(from activities)* | `is_self_picked` | Boolean | Computed from activity analysis |
| *(from activities)* | `assigned_by` | VarChar(255) | Who assigned the ticket (null if self-picked) |
| *(from activities)* | `first_assigned_at` | DateTime | When first assignment occurred |
| *(from activities)* | `first_public_agent_reply_at` | DateTime | First public reply timestamp |

### Agent → Technician ID Mapping

**CRITICAL**: FreshService uses its own agent IDs (large numbers like `21000123456`). Our database uses internal auto-increment IDs. You must maintain a mapping.

```javascript
// Build the mapping: FreshService ID → Internal ID
const technicians = await prisma.technician.findMany({ where: { isActive: true } });
const fsIdToInternalId = new Map(
  technicians.map(tech => [Number(tech.freshserviceId), tech.id])
);

// Map a ticket's responder to our internal ID
const internalTechId = fsIdToInternalId.get(Number(ticket.responder_id));
```

The `responder_id` field on a FreshService ticket is the assigned agent's FreshService ID. We resolve it to our internal technician ID during sync.

---

## 16. Status & Priority Codes

### Ticket Status Codes

| FreshService Code | Status String | Description |
|---|---|---|
| `2` | Open | New/open ticket |
| `3` | Pending | Waiting on something |
| `4` | Resolved | Resolution provided |
| `5` | Closed | Ticket closed |
| `6` | Waiting on Customer | Awaiting customer response |
| `7` | Waiting on Third Party | Awaiting external vendor |

```javascript
const STATUS_MAP = {
  2: 'Open',
  3: 'Pending',
  4: 'Resolved',
  5: 'Closed',
  6: 'Waiting on Customer',
  7: 'Waiting on Third Party',
};
```

### Priority Codes

| FreshService Code | Priority | Label |
|---|---|---|
| `1` | Low | P4 |
| `2` | Medium | P3 |
| `3` | High | P2 |
| `4` | Urgent | P1 |

> **Note**: Our display labels invert the numbering for user-friendliness: Priority 4 (Urgent) displays as "P1" (highest priority), Priority 1 (Low) displays as "P4" (lowest priority).

---

## 17. Source Codes

The `source` field on tickets indicates how the ticket was created.

### Standard Source Codes

| Code | Source |
|------|--------|
| `1` | Email |
| `2` | Portal |
| `3` | Phone |
| `4` | Chat |
| `5` | Feedback Widget |
| `6` | Yammer |
| `7` | AWS CloudWatch |
| `8` | Pagerduty |
| `9` | Walkup |
| `10` | Slack |

### Custom Source Codes

FreshService allows custom source IDs (typically 1000+) for programmatic ticket creation. Teams in our organization use:

| Code | Source | Used By |
|------|--------|---------|
| `1001` | Custom API Integration | Task management system (ticket creation flow) |

> **Note**: When creating tickets programmatically, you can set a custom `source` value to distinguish API-created tickets from user-created ones. This is useful for reporting and filtering. Check with your FreshService admin for your organization's custom source IDs.

---

## 18. Rate Limiting & Retry Logic

### Official vs Practical Limits

| Metric | Official Documentation | Practical Reality |
|---|---|---|
| Requests/hour | 5,000 | 5,000 |
| Safe sustained rate | ~5 req/sec | **~1 req/sec** |
| Burst tolerance | Not documented | Low - 429 errors at ~2 req/sec |

> **IMPORTANT**: While FreshService documents 5,000 req/hour, in practice you will get HTTP 429 errors at sustained rates above ~1-2 requests per second. **Always implement retry logic.**

### Rate Limit Headers

FreshService returns these headers on every response:

| Header | Description |
|---|---|
| `x-ratelimit-total` | Total requests allowed per hour |
| `x-ratelimit-remaining` | Requests remaining this hour |
| `x-ratelimit-used-currentrequest` | Requests used so far |

### Recommended Retry Logic

```javascript
async function fetchWithRetry(client, endpoint, config = {}, maxRetries = 3) {
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await client.get(endpoint, config);
    } catch (error) {
      lastError = error;
      const status = error.response?.status;

      // Only retry on 429 (rate limit) errors
      if (status === 429 && attempt < maxRetries) {
        // Exponential backoff: 5s, 10s, 20s
        const delayMs = 5000 * Math.pow(2, attempt - 1);
        console.warn(
          `Rate limit hit (429) on ${endpoint}. ` +
          `Retrying in ${delayMs / 1000}s (attempt ${attempt}/${maxRetries})...`
        );
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue;
      }

      throw error;
    }
  }

  throw lastError;
}
```

### Rate Limiting Best Practices

1. **Always add a 1-second delay** between paginated requests
2. **Use exponential backoff** on 429 errors (5s, 10s, 20s)
3. **Max 3 retries** before giving up
4. **Sequential activity fetching** - don't parallelize heavily
5. **If batching activity calls**, limit concurrency to 5-10 with 3-5s between batches
6. **Monitor** `x-ratelimit-remaining` header to proactively slow down
7. **Let 429 errors pass through** your error interceptor so retry logic can handle them

### Interceptor Pattern (Don't Wrap 429s)

```javascript
// IMPORTANT: Let 429 errors pass through unwrapped
client.interceptors.response.use(
  response => response,
  error => {
    const status = error.response?.status;

    // Let 429 errors pass through for retry logic
    if (status === 429) {
      throw error;  // Don't wrap
    }

    // Wrap all other errors
    throw new ExternalAPIError('FreshService', error.message, error);
  }
);
```

---

## 19. Pagination

### How FreshService Pagination Works

- **Maximum per page**: 100 items
- **Page numbering**: 1-based (starts at page 1)
- **Last page detection**: If results count < 100, you're on the last page
- **No total count header**: FreshService does NOT return total item count

### Complete Pagination Implementation

```javascript
async function fetchAllPages(client, endpoint, params = {}) {
  const allResults = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const response = await fetchWithRetry(client, endpoint, {
      params: {
        ...params,
        page,
        per_page: 100,
      },
    });

    // Extract results based on endpoint
    const data = response.data;
    let results;
    if (endpoint.includes('/tickets')) results = data.tickets || [];
    else if (endpoint.includes('/agents')) results = data.agents || [];
    else if (endpoint.includes('/requesters')) results = data.requesters || [];
    else results = data;

    if (results && results.length > 0) {
      allResults.push(...results);
      page++;

      // Last page detection
      if (results.length < 100) {
        hasMore = false;
      }
    } else {
      hasMore = false;
    }

    // Rate limiting: 1 second between requests
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  return allResults;
}
```

### Pagination Performance

| Items | Pages | Time (1s/page) | Notes |
|-------|-------|----------------|-------|
| 100 | 1 | 1s | Single page |
| 1,000 | 10 | 10s | |
| 5,000 | 50 | 50s | |
| 10,000 | 100 | ~100s (1.7 min) | Typical large fetch |

---

## 20. Known Limitations & Gotchas

### 1. No Date Range Filter (Most Impactful)

**Problem**: `updated_since` returns ALL tickets updated since that date. There is **no `updated_before` parameter**.

**Impact**: To get tickets for a specific week (e.g., May 19-25), you must:
1. Fetch ALL tickets since May 19 (could be 7,000+)
2. Filter client-side to only the ones in your date range

```javascript
// Fetching one week of data
const allTickets = await fetchAllTickets({
  updated_since: '2025-05-19T00:00:00Z',
});
// Returns ~7,766 tickets (everything since May 19)

// Must filter client-side
const weekTickets = allTickets.filter(ticket => {
  const updated = new Date(ticket.updated_at);
  return updated >= new Date('2025-05-19') && updated <= new Date('2025-05-25T23:59:59Z');
});
// Results in ~314 tickets for that week
// Efficiency: ~4% of fetched data is actually needed
```

### 2. No Bulk Activity Endpoints

**Problem**: Must call `/tickets/{id}/activities` for **each ticket individually**.

**Impact**: 300 tickets = 300 API calls = ~5 minutes at safe rate limits.

**Mitigation**: Batch processing with concurrency control:
```javascript
// Process activities in batches of 10, with 3s between batches
// ~2 req/sec average, safe with retry logic
```

### 3. No Bulk Ticket Fetch by IDs

**Problem**: Cannot fetch specific tickets by a list of IDs in one call. Must use pagination with filters.

### 4. Workspace Filtering is Partial

**Problem**: `workspace_id` parameter on `/agents` helps filter, but agents can belong to multiple workspaces. Always verify `workspace_ids` array client-side.

### 5. BigInt IDs

**Problem**: FreshService uses very large numeric IDs (e.g., `21000123456`). These exceed JavaScript's safe integer limit.

**Solution**: Use `BigInt` in your database schema and be careful with JSON serialization:

```javascript
// Store as BigInt in database
freshserviceId: BigInt(agent.id)

// Convert back to Number for API calls
const fsId = Number(technician.freshserviceId);
```

### 6. Activity Content Parsing is Fragile

**Problem**: Assignment detection relies on parsing string content like `" set Agent as John Doe"`. This format could change without notice.

**Mitigation**: Use defensive parsing with fallbacks:
```javascript
if (activity.content && activity.content.includes('set Agent as')) {
  const match = activity.content.match(/set Agent as (.+)/);
  if (match) { /* ... */ }
}
```

### 7. Requester Data May Be Incomplete

**Problem**: Using `include=requester` on tickets sometimes returns partial data. The full requester object requires a separate `/requesters/{id}` call.

### 8. API Timeout

**Problem**: Large queries can take 10-30 seconds. FreshService may return 504 Gateway Timeout.

**Solution**: Set client timeout to at least 30 seconds:
```javascript
const client = axios.create({
  timeout: 30000,  // 30 seconds
});
```

### 9. `include=stats` Returns Resolution Time

The `stats` include provides `resolution_time_in_secs` but NOT first response time. First response time must be calculated from activities.

### 10. Time Tracking Requires Separate API

Time entries (hours logged) are not included in the ticket object. They require separate `/tickets/{id}/time_entries` calls.

### 11. Due Dates Must Be in the Future

**Problem**: FreshService rejects `due_by` and `fr_due_by` values that are in the past with HTTP 400.

**Impact**: If your source data has a past due date and you send it directly, ticket creation/update fails.

**Solution**: Validate dates before sending. Silently drop past dates if needed:
```javascript
if (new Date(dueDate) > new Date()) {
  payload.due_by = dueDate;
}
```

### 12. Ticket URL Domain May Differ from API Domain

**Problem**: The FreshService agent portal URL (where users view tickets) may use a custom domain different from the API domain (e.g., `it.bgcengineering.ca` vs `efusion.freshservice.com`).

**Impact**: If you hardcode the domain when constructing ticket URLs, they may not work.

**Solution**: Derive the ticket URL from a configurable setting, not the API domain:
```javascript
const PORTAL_DOMAIN = process.env.FRESHSERVICE_PORTAL_DOMAIN || process.env.FRESHSERVICE_DOMAIN;
const ticketUrl = `https://${PORTAL_DOMAIN}/a/tickets/${ticketId}`;
```

### 13. Agent ID Type Mismatch

**Problem**: FreshService agent IDs are large integers. If you store them as strings in your database (common in document stores like Firestore), you must parse them to integers before sending to FreshService.

**Impact**: Sending a string `responder_id` causes 400 errors. Sending `NaN` causes silent assignment failure.

**Solution**: Always validate and convert:
```javascript
const agentId = parseInt(storedAgentId, 10);
if (!isNaN(agentId)) {
  payload.responder_id = agentId;
}
```

### 14. No Bidirectional Sync by Default

**Problem**: Ticket status changes in FreshService (resolved, closed, reassigned) are NOT automatically reflected in your application.

**Impact**: Your local data can diverge from FreshService reality.

**Solution**: Implement webhooks, polling, or SSE-based sync (see Section 9).

### 15. Technician Sync Pagination

**Problem**: Fetching agents with `per_page=100` only returns the first 100 agents. If your organization has more than 100 active agents, you need pagination.

**Solution**: Use the full pagination pattern from Section 19 for agent fetching, not just a single page.

### 16. Category Form Field ID is Instance-Specific

**Problem**: The category custom field ID (e.g., `1000158814`) is specific to your FreshService form configuration. If the form is modified, this ID may change.

**Solution**: Look up the field by label as a fallback, and log warnings if the expected ID is not found:
```javascript
const field = fields.find(f => f.id === EXPECTED_ID) ||
              fields.find(f => f.label === 'Category');
```

### 17. Workspace IDs Vary Between Teams

**Problem**: Different teams may use different workspace IDs. Our Ticket Pulse dashboard uses workspace ID from env config for IT, while other integrations may hardcode different values (e.g., `workspace_id: 2`).

**Solution**: Always use environment variables or configuration for workspace IDs. Never hardcode them:
```javascript
// Good
const workspaceId = process.env.FRESHSERVICE_WORKSPACE_ID;

// Bad
const workspaceId = 2;  // Will break if team targets a different workspace
```

### 18. DELETE is Permanent

**Problem**: `DELETE /tickets/{id}` permanently removes the ticket. There is no trash or soft-delete mechanism.

**Impact**: Deleted tickets cannot be recovered. Activities, time entries, and CSAT responses are also deleted.

**Solution**: Consider implementing a "soft unlink" pattern (clear local reference without deleting from FreshService) as the default, with hard delete as an explicit user action.

---

## 21. Code Examples

### Complete Working Client (JavaScript/Node.js)

```javascript
import axios from 'axios';

class FreshServiceClient {
  constructor(domain, apiKey) {
    const fullDomain = domain.includes('.freshservice.com')
      ? domain
      : `${domain}.freshservice.com`;

    this.client = axios.create({
      baseURL: `https://${fullDomain}/api/v2`,
      headers: { 'Content-Type': 'application/json' },
      auth: { username: apiKey, password: 'X' },
      timeout: 30000,
    });

    // Let 429 errors through for retry logic
    this.client.interceptors.response.use(
      response => response,
      error => {
        if (error.response?.status === 429) throw error;
        throw new Error(
          `FreshService API Error: ${error.response?.status} - ${error.response?.data?.description || error.message}`
        );
      }
    );
  }

  async _fetchWithRetry(endpoint, config = {}, maxRetries = 3) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.client.get(endpoint, config);
      } catch (error) {
        lastError = error;
        if (error.response?.status === 429 && attempt < maxRetries) {
          const delay = 5000 * Math.pow(2, attempt - 1);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw error;
      }
    }
    throw lastError;
  }

  async fetchAllPages(endpoint, params = {}) {
    const all = [];
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const response = await this._fetchWithRetry(endpoint, {
        params: { ...params, page, per_page: 100 },
      });

      const key = endpoint.includes('/tickets') ? 'tickets'
        : endpoint.includes('/agents') ? 'agents'
        : endpoint.includes('/requesters') ? 'requesters'
        : null;

      const results = key ? response.data[key] || [] : response.data;

      if (results.length > 0) {
        all.push(...results);
        if (results.length < 100) hasMore = false;
        else page++;
      } else {
        hasMore = false;
      }

      await new Promise(r => setTimeout(r, 1000)); // Rate limit
    }

    return all;
  }

  // Tickets
  async getTickets(params = {}) {
    return this.fetchAllPages('/tickets', params);
  }

  async getTicket(id) {
    const res = await this.client.get(`/tickets/${id}`);
    return res.data.ticket;
  }

  async createTicket(data) {
    const res = await this.client.post('/tickets', data);
    return res.data.ticket;
  }

  async updateTicket(id, data) {
    const res = await this.client.put(`/tickets/${id}`, data);
    return res.data.ticket;
  }

  async deleteTicket(id) {
    await this.client.delete(`/tickets/${id}`);
    return true;
  }

  // Agents
  async getAgents(params = {}) {
    return this.fetchAllPages('/agents', params);
  }

  async getAgent(id) {
    const res = await this.client.get(`/agents/${id}`);
    return res.data.agent;
  }

  // Activities
  async getTicketActivities(ticketId) {
    const res = await this._fetchWithRetry(`/tickets/${ticketId}/activities`);
    return res.data.activities || [];
  }

  // CSAT
  async getTicketCSAT(ticketId) {
    try {
      const res = await this._fetchWithRetry(`/tickets/${ticketId}/csat_response`);
      return res.data.csat_response || null;
    } catch (error) {
      if (error.response?.status === 404) return null;
      throw error;
    }
  }

  // Connection test
  async testConnection() {
    try {
      await this.client.get('/agents', { params: { per_page: 1 } });
      return true;
    } catch {
      return false;
    }
  }

  // Rate limit info
  async getRateLimitInfo() {
    const res = await this.client.get('/agents', { params: { per_page: 1 } });
    return {
      limit: res.headers['x-ratelimit-total'],
      remaining: res.headers['x-ratelimit-remaining'],
      used: res.headers['x-ratelimit-used-currentrequest'],
    };
  }
}

export default FreshServiceClient;
```

### Python Example

```python
import requests
import time

class FreshServiceClient:
    def __init__(self, domain, api_key):
        full_domain = domain if '.freshservice.com' in domain else f'{domain}.freshservice.com'
        self.base_url = f'https://{full_domain}/api/v2'
        self.auth = (api_key, 'X')
        self.session = requests.Session()
        self.session.auth = self.auth
        self.session.headers.update({'Content-Type': 'application/json'})

    def _fetch_with_retry(self, endpoint, params=None, max_retries=3):
        url = f'{self.base_url}{endpoint}'
        for attempt in range(1, max_retries + 1):
            response = self.session.get(url, params=params, timeout=30)
            if response.status_code == 429 and attempt < max_retries:
                delay = 5 * (2 ** (attempt - 1))
                print(f'Rate limited. Retrying in {delay}s...')
                time.sleep(delay)
                continue
            response.raise_for_status()
            return response.json()
        raise Exception(f'Max retries exceeded for {endpoint}')

    def fetch_all_pages(self, endpoint, params=None):
        params = params or {}
        all_results = []
        page = 1

        while True:
            params['page'] = page
            params['per_page'] = 100
            data = self._fetch_with_retry(endpoint, params)

            # Extract results
            if 'tickets' in data:
                results = data['tickets']
            elif 'agents' in data:
                results = data['agents']
            else:
                results = data

            if not results:
                break

            all_results.extend(results)
            if len(results) < 100:
                break

            page += 1
            time.sleep(1)  # Rate limiting

        return all_results

    def get_tickets(self, **kwargs):
        return self.fetch_all_pages('/tickets', kwargs)

    def get_ticket(self, ticket_id):
        return self._fetch_with_retry(f'/tickets/{ticket_id}')['ticket']

    def create_ticket(self, data):
        url = f'{self.base_url}/tickets'
        response = self.session.post(url, json=data, timeout=30)
        response.raise_for_status()
        return response.json()['ticket']

    def update_ticket(self, ticket_id, data):
        url = f'{self.base_url}/tickets/{ticket_id}'
        response = self.session.put(url, json=data, timeout=30)
        response.raise_for_status()
        return response.json()['ticket']

    def delete_ticket(self, ticket_id):
        url = f'{self.base_url}/tickets/{ticket_id}'
        response = self.session.delete(url, timeout=30)
        response.raise_for_status()
        return True

    def get_agents(self, **kwargs):
        return self.fetch_all_pages('/agents', kwargs)

    def get_ticket_activities(self, ticket_id):
        data = self._fetch_with_retry(f'/tickets/{ticket_id}/activities')
        return data.get('activities', [])


# Usage
client = FreshServiceClient('efusion', 'YOUR_API_KEY')

# List tickets
tickets = client.get_tickets(updated_since='2025-01-01T00:00:00Z', include='requester,stats')

# Get agents in IT workspace
agents = client.get_agents(workspace_id=3)

# Create a ticket
new_ticket = client.create_ticket({
    'subject': 'Test ticket',
    'description': '<p>Test description</p>',
    'email': 'user@company.com',
    'priority': 2,
    'status': 2,
    'custom_fields': {
        'security': 'BST',  # Our "ticket category"
    },
})
```

---

## 22. Environment Setup

### Required Environment Variables

```env
# FreshService API Configuration
FRESHSERVICE_API_KEY=your-freshservice-api-key
FRESHSERVICE_DOMAIN=efusion.freshservice.com
FRESHSERVICE_WORKSPACE_ID=3    # IT workspace (verify with your admin)
```

### Where Credentials Are Stored (Ticket Pulse)

Our system supports two credential sources:

1. **Environment variables** (development): Set in `.env` file
2. **Database settings** (production): Stored in `app_settings` table

The settings repository checks both, with database values taking priority:

```javascript
// Settings keys in app_settings table
// freshservice_domain       → e.g., "efusion.freshservice.com"
// freshservice_api_key      → e.g., "your-api-key"
// freshservice_workspace_id → e.g., "3"
```

### Frontend Configuration

If your frontend needs to link directly to FreshService tickets:

```env
VITE_FRESHSERVICE_DOMAIN=efusion.freshservice.com
```

Build ticket links like:
```javascript
const ticketUrl = `https://${FRESHSERVICE_DOMAIN}/a/tickets/${freshserviceTicketId}`;
```

---

## Appendix: Full Ticket Object Reference

This is a representative FreshService ticket object as returned by the API (with `include=requester,stats`):

```json
{
  "id": 12345,
  "subject": "Cannot connect to VPN",
  "description": "<p>I'm unable to connect to the company VPN from home...</p>",
  "description_text": "I'm unable to connect to the company VPN from home...",
  "status": 2,
  "priority": 3,
  "source": 2,
  "responder_id": 21000123456,
  "requester_id": 21000654321,
  "category": "Network",
  "sub_category": "VPN",
  "is_escalated": false,
  "due_by": "2025-10-16T17:00:00Z",
  "fr_due_by": "2025-10-15T12:00:00Z",
  "created_at": "2025-10-15T09:00:00Z",
  "updated_at": "2025-10-15T14:30:00Z",
  "assigned_at": "2025-10-15T09:15:00Z",
  "resolved_at": null,
  "closed_at": null,

  "custom_fields": {
    "security": "Network",
    "other_custom_field": "some_value"
  },

  "requester": {
    "id": 21000654321,
    "name": "Alice Johnson",
    "email": "alice.johnson@company.com",
    "phone": "+1-555-0100"
  },

  "stats": {
    "agent_responded_at": "2025-10-15T09:45:00Z",
    "requester_responded_at": "2025-10-15T10:00:00Z",
    "first_responded_at": "2025-10-15T09:45:00Z",
    "status_updated_at": "2025-10-15T14:30:00Z",
    "reopened_at": null,
    "resolved_at": null,
    "closed_at": null,
    "pending_since": null,
    "resolution_time_in_secs": null,
    "first_resp_time_in_secs": 2700
  },

  "department": {
    "id": 21000000001,
    "name": "Marketing"
  }
}
```

---

## Quick Reference Card

```
Domain:            efusion.freshservice.com
API Base:          https://efusion.freshservice.com/api/v2
Auth:              Basic Auth (API_KEY:X)
IT Workspace ID:   Configured via FRESHSERVICE_WORKSPACE_ID env var
Max Per Page:      100
Safe Rate:         1 request/second
Retry On:          HTTP 429 (exponential backoff: 5s, 10s, 20s)
Ticket Category:   custom_fields.security (NOT ticket.category!)
Category Field ID: 1000158814 (instance-specific, verify via ticket_form_fields)
Status Codes:      2=Open, 3=Pending, 4=Resolved, 5=Closed
Priority Codes:    1=Low, 2=Medium, 3=High, 4=Urgent
Agent Field:       responder_id (maps to agent.id)
BigInt IDs:        Yes - use BigInt for all FreshService IDs
Due Dates:         Must be in the future (past dates rejected with 400)
DELETE:            Permanent - no trash/undo
Custom Source:     1001 = API integration (standard: 1-10)
```

---

**Document Maintainer**: Ticket Pulse Development Team
**Source of Truth**: Based on production code in `backend/src/integrations/freshservice.js` and `backend/src/integrations/freshserviceTransformer.js`
**FreshService API Docs**: https://api.freshservice.com/v2/
