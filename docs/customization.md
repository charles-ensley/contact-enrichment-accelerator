# Customization & config reference

Everything customer-specific lives in `config/enrichment.config.json`. `inspect` pre-fills it, `configure` refines it, and `generate` renders it. You can also hand-edit it — it is validated by [`config/enrichment.config.schema.json`](../config/enrichment.config.schema.json).

## Fields

| Field | Required | Description |
| --- | --- | --- |
| `companyName` | yes | Customer company name used in the prompt persona. |
| `companyDescription` | no | One-line industry/company description to ground the persona. |
| `crmName` | yes | CRM display name in UI + prompt (default `Salesforce`). Set to a brand only if the CRM is white-labeled. |
| `targetObject` | yes | `Contact` (only supported value in v1). |
| `webSearchProvider` | no | Provider passed to the "Search the Web" data action (default `openai`). |
| `webSearchQuery` | no | Merge-field query expression for the web search. |
| `fields[]` | yes | Write-back target fields the AI may suggest. See below. |
| `sources[]` | yes | Allowed provenance values (subset of `Web_Search`, `LinkedIn`, `ZoomInfo`, `Company_Website`, `News`, `Internal_Analysis`). |
| `linkedIn` | no | LinkedIn "no longer at company" signal (see below). |
| `zoomInfo.simulationField` | no | Include the transient `Enrichment_Source_Data__c` scaffold + seed script. |
| `options.*` | no | Toggles for the auto-capture flow, demo page, and retention job. |

### `fields[]`

```json
{
  "apiName": "Title_Level__c",
  "label": "Title Level",
  "type": "picklist",
  "description": "seniority level",
  "custom": true,
  "restrictedPicklist": true,
  "picklistValues": ["C-Level", "VP", "Director", "Manager", "Individual Contributor"]
}
```

- `type` is one of `string`, `textarea`, `picklist`, `email`, `phone`, `url`, `reference`, `combobox`.
- `description` is the short meaning shown to the model — keep it precise; it directly shapes suggestion quality.
- `custom: true` fields get explicit **field-level security** in both permission sets. Standard fields rely on the user's profile FLS.
- For **restricted** picklists, include the exact `picklistValues`; the prompt constrains suggestions to them and the Apex accept-writer canonicalizes/validates against them.

To **add** a candidate field, copy an entry from the inspection report's "Candidate write-back fields" table into `fields[]`.

### `linkedIn`

```json
{
  "enabled": true,
  "departureFieldApiName": "LID__No_longer_at_Company__c",
  "departureValue": "Not at Company",
  "statusFieldApiName": "Contact_Status__c",
  "statusDepartedValue": "No longer employed here"
}
```

- Only enable if the departure field actually exists in the org (inspect detects it).
- `statusFieldApiName` is the field the (optional) auto-capture flow writes to. If you enable `options.includeAutoCaptureFlow`, this must be set and should also appear in `fields[]`.

## Optional components

| Toggle | Effect |
| --- | --- |
| `options.includeAutoCaptureFlow` | Emits the inactive record-triggered flow that auto-creates a departure suggestion from the LinkedIn signal. Requires `linkedIn.enabled`. Ships **Draft/inactive** — activate deliberately. |
| `options.includeDemoPage` | Emits a clean demo Lightning record page with the widget + suggestions related list. |
| `options.includeRetentionJob` | Emits the schedulable purge job for old dismissed suggestions. |
| `zoomInfo.simulationField` | Emits `Contact.Enrichment_Source_Data__c` + `scripts/seed-enrichment-simulation.apex` so you can demo a paid provider before installing it. |

The reporting components (the **Contact Enrichment Suggestions** report type, the **All Enrichment Suggestions** starter report, and the **Contact Enrichment** folder) are always included — like the object, tab, and quick action — and are not gated by a toggle.

## Tuning the prompt

The prompt body is assembled in [`src/lib/context.js`](../src/lib/context.js) (`buildPromptContent`). Most tuning is data-driven (edit `fields`, `sources`, `webSearchQuery`, `companyDescription`). If you need to change the guardrails or scoring guidelines themselves, edit `buildPromptContent` and re-run `generate`.

## Regenerating

`generate` fully rewrites `generated/`. Safe to run repeatedly. Re-deploy with `deploy`. Metadata is upsert-style, so re-deploying updates existing components in place.
