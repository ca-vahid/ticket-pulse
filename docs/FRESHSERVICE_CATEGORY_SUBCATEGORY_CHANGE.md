# FreshService Category/Subcategory Integration Change

**Audience**: Development teams with FreshService integrations
**Last Updated**: 2026-05-09
**Scope**: IT workspace ticket category/subcategory fields

## Summary

Ticket Pulse changed how IT ticket categories are stored in FreshService.

The old FreshService dropdown field `custom_fields.security` is no longer the current source of truth for IT ticket classification. Ticket Pulse now owns an internal category/subcategory hierarchy connected to technician skills, and mirrors that hierarchy into FreshService through two lookup custom fields:

- `custom_fields.lf_ticket_pulse_category`
- `custom_fields.lf_ticket_pulse_subcategory`

If your application reads, writes, reports on, routes, or syncs IT ticket categories from FreshService, update it to use these new fields.

## What Changed

| Area | Old behavior | New behavior |
|---|---|---|
| Category source of truth | FreshService dropdown/custom field | Ticket Pulse internal category/subcategory hierarchy |
| Main category field | `custom_fields.security` | `custom_fields.lf_ticket_pulse_category` |
| Subcategory field | Not consistently represented by the old dropdown model | `custom_fields.lf_ticket_pulse_subcategory` |
| FreshService field type | Dropdown/static choices | Custom lookup fields |
| Lookup source | Ticket form field choices | FreshService custom objects with parent linkage |
| Write payload | Dropdown value string, e.g. `"Network"` | Lookup record display ID, e.g. `7` |

The built-in FreshService fields `ticket.category` and `ticket.sub_category` are still not the Ticket Pulse operational category system.

## FreshService Fields

| Field label | API name | Type | Backing custom object |
|---|---|---|---|
| Ticket Pulse Category | `lf_ticket_pulse_category` | `custom_lookup` | `Ticket Pulse Skills` |
| Ticket Pulse Subcategory | `lf_ticket_pulse_subcategory` | `custom_lookup` | `Ticket Pulse Subskills` |

The subskill hierarchy is stored on the `Ticket Pulse Subskills` records through a required lookup field:

| Custom object | Field | Type | Purpose |
|---|---|---|---|
| `Ticket Pulse Subskills` | `parent_skill` | Lookup to `Ticket Pulse Skills` | Connects each subcategory to its parent category. |

Known production metadata at the time of writing:

| Item | ID |
|---|---|
| `lf_ticket_pulse_category` field | `1000170004` |
| `lf_ticket_pulse_subcategory` field | `1000170005` |
| `Ticket Pulse Skills` object | `1000000538` |
| `Ticket Pulse Subskills` object | `1000000539` |

Treat these IDs as environment-specific FreshService metadata. Prefer discovery by field API name/object title where possible.

## Reading Tickets

Read the new fields from `ticket.custom_fields`:

```javascript
const categoryValue = ticket.custom_fields?.lf_ticket_pulse_category;
const subcategoryValue = ticket.custom_fields?.lf_ticket_pulse_subcategory;
```

FreshService lookup values may come back as numeric display IDs, strings, or object-shaped values depending on the endpoint/serializer. If your UI or reporting needs readable names, resolve the lookup value against records from:

- `Ticket Pulse Skills`
- `Ticket Pulse Subskills`

Ticket Pulse sync resolves those lookup display IDs back to readable local category/subcategory names before storing them internally.

For category-constrained subcategory UX, read `parent_skill` from each `Ticket Pulse Subskills` record. FreshService returns this as a lookup object similar to:

```json
{
  "parent_skill": {
    "id": 11,
    "value": "Service Desk & Routing"
  }
}
```

## Writing Tickets

When writing the current IT category/subcategory back to FreshService, send lookup record display IDs, not names.

```javascript
await client.put(`/tickets/${ticketId}`, {
  custom_fields: {
    lf_ticket_pulse_category: 7,
    lf_ticket_pulse_subcategory: 66,
  },
});
```

Do not send this for the new fields:

```javascript
await client.put(`/tickets/${ticketId}`, {
  custom_fields: {
    lf_ticket_pulse_category: 'Security',
    lf_ticket_pulse_subcategory: 'Threat Intelligence / Security Advisory',
  },
});
```

FreshService may return HTTP success for the wrong value shape while the lookup value does not visibly persist. Resolve the category/subcategory names to custom object record display IDs before calling `PUT /api/v2/tickets/{id}`.

## Discovering Fields and Lookup Records

Use the ticket form fields endpoint to discover the field API names:

```bash
curl -u "YOUR_API_KEY:X" \
  "https://efusion.freshservice.com/api/v2/ticket_form_fields"
```

Find:

- `name === "lf_ticket_pulse_category"` or label `Ticket Pulse Category`
- `name === "lf_ticket_pulse_subcategory"` or label `Ticket Pulse Subcategory`

Use FreshService custom object endpoints to discover lookup objects and records:

```bash
curl -u "YOUR_API_KEY:X" \
  "https://efusion.freshservice.com/api/v2/objects?workspace_id=<IT_WORKSPACE_ID>"

curl -u "YOUR_API_KEY:X" \
  "https://efusion.freshservice.com/api/v2/objects/<OBJECT_ID>/records?page_size=100"
```

Find objects by title:

- `Ticket Pulse Skills`
- `Ticket Pulse Subskills`

For each record, map the readable name to its display ID. Ticket Pulse's working pattern is to read record name from `record.data.name` or `record.name`, and display ID from `record.data.bo_display_id`, `record.bo_display_id`, or the record ID fallback.

For `Ticket Pulse Subskills`, also read/write `record.data.parent_skill`. When writing a subskill record, send the parent skill display ID:

```json
{
  "data": {
    "name": "Password & MFA",
    "parent_skill": 1
  }
}
```

Endpoint shape:

```http
PUT /api/v2/objects/{ticket_pulse_subskills_object_id}/records/{subskill_display_id}
```

## Migration Checklist

1. Replace reads from `custom_fields.security` with reads from `custom_fields.lf_ticket_pulse_category` and `custom_fields.lf_ticket_pulse_subcategory`.
2. Stop using FreshService built-in `category` and `sub_category` as Ticket Pulse category/subcategory data.
3. Build or cache a lookup map from the `Ticket Pulse Skills` and `Ticket Pulse Subskills` custom object records.
4. For display/reporting, map lookup display IDs back to category/subcategory names.
5. For writes, map category/subcategory names to lookup record display IDs before updating the ticket.
6. For FreshService object sync, create/update `Ticket Pulse Subskills` records with `parent_skill` pointing to the correct `Ticket Pulse Skills` display ID.
7. Keep `custom_fields.security` only as a transition fallback for older tickets or integrations that have not migrated yet.
8. Validate on a low-risk ticket that FreshService visibly persists both lookup fields after the API write.

## Ticket Pulse Sync Behavior

Ticket Pulse now treats `parent_skill` as part of FreshService drift/sync for the IT hierarchy:

- creates missing `Ticket Pulse Skills` records
- creates missing `Ticket Pulse Subskills` records with `parent_skill`
- detects missing subskill parent lookups
- detects subskills pointing to the wrong parent skill
- updates existing subskill records to restore the correct `parent_skill`

Current live validation after backfill showed `101` subskill records, `0` missing parents, `0` wrong parents, and `0` unresolved parent mappings.

## Compatibility Notes

- This change is currently scoped to the IT workspace category/subcategory migration.
- Other workspaces may still be on older field defaults until they are migrated.
- Do not hardcode field IDs or object IDs as universal constants. They are useful for validation, but field API names and object titles are safer discovery keys.
- The full FreshService integration guide has more API, auth, pagination, and rate-limit context: `docs/FRESHSERVICE_INTEGRATION_GUIDE_V2.md`.
