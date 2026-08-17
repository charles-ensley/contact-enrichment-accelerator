# Contact Enrichment Accelerator

Stand up an **AI-powered Contact data-hygiene workflow** in any Salesforce org in minutes.

The accelerator inspects your connected org, figures out what already exists versus what needs to be created, then generates a tailored, deployable package: an Einstein **prompt template** that compares each Contact against a live **web search** (and optional LinkedIn / ZoomInfo signals), a **screen flow** that turns the AI's JSON output into reviewable **suggestion records**, and a Lightning **widget** where reps **accept / dismiss** each suggestion with full history.

No company-specific branding, field names, or picklists are baked in — everything customer-specific is discovered from your org and rendered from a single config file.

```
inspect  ->  configure  ->  generate  ->  deploy
 (org)       (wizard)       (package)     (org)
```

## What you get

- **`Contact_Enrichment_Suggestion__c`** custom object (+ fields, list views, tab) — the audit trail of every AI suggestion.
- **`Contact_Enrichment_Analysis`** Einstein prompt template (flex, JSON output) grounded on a record snapshot + a "Search the Web" data action.
- **`ContactEnrichmentOutput`** Lightning type — the structured JSON schema (up to 5 suggestions).
- **`Generate_Contact_Enrichment_Suggestions`** screen flow — runs the prompt, parses the JSON, and creates suggestion records.
- **`contactEnrichmentWidget`** LWC + **`ContactEnrichmentController`** Apex — accept/dismiss UI with type-safe, FLS-checked write-back to the Contact. Shows the last-checked time, color-coded confidence, collapsible rationale per suggestion, and a clear prompt to run the first check.
- **Custom report type** (`Contact_Enrichment_Suggestions`) + a starter **"All Enrichment Suggestions"** report in a **"Contact Enrichment"** folder — track suggestion volume, acceptance/dismissal rates, sources, and confidence out of the box.
- **Permission sets** (`Contact_Enrichment_Rep`, `Contact_Enrichment_Admin`) + custom permission, wired with field-level security for exactly the fields you chose.
- Optional add-ons: an inactive **LinkedIn auto-capture flow**, a **ZoomInfo simulation** scaffold, a **retention purge job**, and a clean **demo record page**.

## Prerequisites

- [Salesforce CLI (`sf`)](https://developer.salesforce.com/tools/salesforcecli) authenticated to your target org (`sf org login web`).
- **Node.js 18+**.
- In the target org: **Einstein Generative AI / Prompt Builder** enabled, and the **Search the Web** data action available in the Einstein Trust Layer (provider `openai` by default).

## Quickstart

```bash
git clone <this-repo>
cd contact-enrichment-accelerator
npm install

# 1. Inspect the org (reads Contact fields + detects signals, writes a report + starter config)
npm run inspect -- --org myOrgAlias

# 2. Refine interactively (CRM name, fields, sources, LinkedIn/ZoomInfo, options)
npm run configure

# 3. Render the tailored package and dry-run validate against the org
npm run generate -- --org myOrgAlias

# 4. Deploy and assign permission sets
npm run deploy -- --org myOrgAlias
```

Then finish the [post-install steps](docs/post-install.md) (publish the prompt template, assign perm sets, drop the widget on the Contact page).

## Commands

| Command | What it does |
| --- | --- |
| `npm run inspect -- --org <alias>` | Describes `Contact`, detects LinkedIn/ZoomInfo signals and candidate write-back fields, flags name collisions, and writes `reports/inspection-<org>.md` + `config/enrichment.config.json`. |
| `npm run configure` | Interactive wizard that finalizes the config. |
| `npm run generate -- --org <alias>` | Renders `templates/` -> `generated/` using your config, writes `manifest/package.xml` + `install.sh`, and runs `sf project deploy start --dry-run`. Add `--no-validate` to skip the dry-run. |
| `npm run deploy -- --org <alias>` | Deploys `generated/force-app` and assigns the admin permission set. Add `-- --test-level RunLocalTests` for production. |

You can also call the CLI directly: `node src/cli.js <command> --help`.

## How it stays generic

No prior-customer branding, field names, or picklists are baked in. Customer-specific values live **only** in `config/enrichment.config.json` and are rendered into the metadata at `generate` time:

- The **prompt body** (company persona, CRM name, the exact field catalog + picklist constraints, which sources are allowed, the web-search query) is generated from your config.
- **Permission-set field-level security** is emitted for exactly the custom write-back fields you selected.
- The **LinkedIn** signal, **ZoomInfo** simulation, **auto-capture flow**, **retention job**, and **demo page** are included only when you turn them on.

See [`docs/architecture.md`](docs/architecture.md) for the design and [`docs/customization.md`](docs/customization.md) for the config reference.

## Repo layout

```
config/      JSON Schema + example + your generated config
templates/   de-branded base metadata; dynamic files use {{ }} placeholders
src/         Node CLI (inspect | configure | generate | deploy)
generated/   rendered, deployable package (gitignored)
reports/     inspection reports (gitignored)
docs/        architecture, customization, post-install
```

## License

MIT — see [LICENSE](LICENSE).
