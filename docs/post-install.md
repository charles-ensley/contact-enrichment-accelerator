# Post-install steps

After `npm run deploy` succeeds, finish the setup in the org.

## 1. Assign permission sets

- **Contact Enrichment - Rep** (`Contact_Enrichment_Rep`) → sales / relationship-management users. Grants the widget, the flow, and accept/dismiss.
- **Contact Enrichment - Admin** (`Contact_Enrichment_Admin`) → admins / data stewards. Superset that adds the Suggestion tab, list views, cross-contact history, and the retention job (if included).

```bash
sf org assign permset -n Contact_Enrichment_Rep -o <alias>
sf org assign permset -n Contact_Enrichment_Admin -o <alias>
```

(The deploy step auto-assigns Admin to the running user.)

## 2. Publish / activate the prompt template

The template ships as **Draft** so it deploys cleanly to any org.

1. Open **Setup → Einstein → Prompt Builder**.
2. Open **Contact Enrichment Analysis**.
3. Confirm the model and the **Search the Web** data action (provider `openai`), then **Save** and **Activate**.

> Requires Einstein Generative AI / Prompt Builder to be enabled and the Search the Web action allowed in the Einstein Trust Layer.

## 3. Add the widget to the Contact page

Either:

- **Activate the demo page** (if you included it): Setup → Lightning App Builder → open **Contact Enrichment Demo Page** → **Activation** → set as org default / app default. It already contains the widget + suggestions related list.
- **Or edit your existing Contact record page**: drag the **Contact Enrichment Widget** component onto the layout and save.

The **Run Enrichment Check** quick action is also available to add to the Contact page layout / highlights panel.

## 4. (Optional) Schedule the retention job

If you included the retention job, schedule it to purge old dismissed suggestions (accepted ones are always kept):

```apex
System.schedule('Contact Enrichment Retention', '0 0 2 * * ?', new ContactEnrichmentRetentionJob());
```

The default retention window is 90 days (`ContactEnrichmentRetentionJob.retentionDays`).

## 5. (Optional) Seed a simulated provider

If you enabled the ZoomInfo simulation, edit `generated/scripts/seed-enrichment-simulation.apex` with real Contact Ids and run:

```bash
sf apex run -o <alias> -f generated/scripts/seed-enrichment-simulation.apex
```

This populates `Contact.Enrichment_Source_Data__c` so a simulated provider-sourced suggestion appears alongside the live web-search results. Set the field back to `null` to clean up.

## 6. Smoke test

1. Open a Contact with an `Account`.
2. Click **Run Enrichment Check** (or the widget button) and let the flow run.
3. Review the generated suggestions; **Accept** one and confirm the Contact field updates; **Dismiss** one with a reason and confirm it moves to history.

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| Deploy fails on `GenAiPromptTemplate` | Einstein / Prompt Builder not enabled in the org. |
| Flow runs but no suggestions | Search the Web action not enabled, or the model returned "no discrepancies". Check the prompt in Prompt Builder. |
| Accept fails with a permission error | The write-back field is missing FLS. Ensure the field is in `config.fields` with `custom: true`, regenerate, and redeploy. |
| Auto-capture flow errors | It writes to `linkedIn.statusFieldApiName`; make sure that field exists and is in `config.fields`. The flow ships inactive by design. |
