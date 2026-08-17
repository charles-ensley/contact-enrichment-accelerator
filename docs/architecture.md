# Architecture

## Runtime solution (what gets deployed)

```
                 ┌─────────────────────────────────────────────────────────┐
                 │ Contact record page                                     │
                 │  ┌───────────────────────────────────────────────────┐ │
   Rep clicks →  │  │ contactEnrichmentWidget (LWC)                     │ │
  "Run Check"    │  │   • embeds the screen flow                        │ │
                 │  │   • lists Pending / Reviewed suggestions          │ │
                 │  │   • Accept / Dismiss (+ reason) / Accept all      │ │
                 │  └───────────────┬───────────────────────────────────┘ │
                 └──────────────────┼─────────────────────────────────────┘
                                    │ Apex (ContactEnrichmentController)
                                    │  • FLS + type-safe write-back
                                    ▼
   ┌──────────────┐   flow    ┌───────────────────────────┐   creates   ┌───────────────────────────────┐
   │ Screen flow  │ ────────► │ Prompt template           │ ──JSON────► │ Contact_Enrichment_Suggestion │
   │ Generate_... │           │ Contact_Enrichment_       │             │ __c  (audit trail)            │
   │              │ ◄──JSON── │ Analysis (flex)           │             └───────────────────────────────┘
   └──────────────┘           │  grounding:               │
                              │   • Record snapshot        │
                              │   • Search the Web action  │
                              │   • (opt) LinkedIn flag     │
                              │   • (opt) ZoomInfo sim      │
                              └───────────────────────────┘
```

1. A rep runs the **screen flow** from the widget (or the "Run Enrichment Check" quick action).
2. The flow invokes the **prompt template**, which is grounded on a full **record snapshot** and a live **web search**, and (optionally) the LinkedIn "no longer at company" flag and simulated ZoomInfo data.
3. The model returns **structured JSON** conforming to the `ContactEnrichmentOutput` Lightning type (up to 5 suggestions, each with field API name, current/suggested value, source, confidence, rationale, category).
4. The flow deletes stale pending suggestions and creates one `Contact_Enrichment_Suggestion__c` per returned suggestion, then updates the Contact's `Last_Enrichment_Check__c` / `Pending_Enrichment_Count__c`.
5. The rep **accepts** (writes the value back to the Contact with FLS + picklist validation in Apex) or **dismisses** (with a reason). Accepted/dismissed records form the history.
6. An optional **retention job** purges old dismissed suggestions; accepted ones are kept as an audit trail.

## Generator (how the package is produced)

```
config/enrichment.config.json
        │
        ▼
  buildContext()  ──►  Handlebars context (crmName, fields, sources,
   (src/lib/context.js)   linkedIn, zoomInfo, options, promptContent)
        │
        ▼
  renderTree()    ──►  every file in templates/force-app is compiled with
   (src/lib/render.js)   Handlebars; conditional files are skipped
        │
        ▼
  generated/force-app  +  manifest/package.xml  +  install.sh
```

- **`src/lib/sfClient.js`** — thin wrapper over the `sf` CLI (`--json`), used by `inspect`, `generate --dry-run`, and `deploy`.
- **`src/lib/describe.js`** — turns a `Contact` describe into candidate write-back fields, LinkedIn/ZoomInfo signal detection, and name-collision checks.
- **`src/lib/context.js`** — builds the render context and assembles the full, XML-escaped **prompt body** from the config.
- **`src/lib/render.js`** — walks `templates/`, applies Handlebars, and enforces conditional inclusion.

### Static vs. dynamic templates

| Static (copied, de-branded once) | Dynamic (tokenized / conditional) |
| --- | --- |
| Suggestion object + fields, list views, tab, layout | Prompt template body (fields, picklists, CRM name, sources, web query) |
| `ContactEnrichmentOutput` schema (only CRM label) | Permission-set FLS for the selected custom fields |
| Screen flow structure | Confirmation-screen source text |
| LWC html/css/js core | Widget CRM label |
| Apex controller (+ retention job) + tests | Auto-capture flow (fields + conditional) |
| Custom permission, quick action | ZoomInfo simulation field + seed script (conditional) |
| Report type, "All Enrichment Suggestions" report, report folder | — |

## Design choices

- **Contact-typed v1.** The Apex/LWC target the `Contact` object to match the use case. The config records `targetObject` to leave room for an object-agnostic v2, but multi-object rendering is out of scope for v1.
- **Reuse over recreate.** Write-back target fields are always reused from the org; the accelerator never recreates standard/custom fields you already have. It only adds its own workflow object/fields.
- **Prompt template ships as `Draft`.** The generated template has no org-specific version hash, so it deploys cleanly to a new org; you publish/activate it in Prompt Builder post-install.
- **Sanitized display strings.** Company/CRM names are sanitized so they are safe to inject into XML, JSON, and JavaScript alike.
