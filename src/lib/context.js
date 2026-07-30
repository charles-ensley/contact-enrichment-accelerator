/**
 * Turn a validated enrichment config into the context object consumed by the
 * Handlebars templates. The heavy lifting is `buildPromptContent`, which renders
 * the full, XML-escaped prompt body from the customer's fields and signals.
 */

/** Remove characters that would break XML/JSON/JS when injected as a display string. */
export function sanitizeDisplay(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, 'and')
    .replace(/[<>"'`{}\\]/g, '')
    .trim();
}

export function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const DEFAULT_WEB_SEARCH_QUERY =
  '{!$Input:Contact.Name} {!$Input:Contact.Account.Name} current employer and job title - latest role or departure news';

export function buildPromptContent(cfg) {
  const crm = sanitizeDisplay(cfg.crmName || 'Salesforce');
  const company = sanitizeDisplay(cfg.companyName || '');
  const companyDesc = sanitizeDisplay(cfg.companyDescription || '');
  const li = cfg.linkedIn && cfg.linkedIn.enabled ? cfg.linkedIn : null;
  const zoom = cfg.zoomInfo && cfg.zoomInfo.simulationField;
  const sources = (cfg.sources && cfg.sources.length ? cfg.sources : ['Web_Search']).join('; ');
  const statusField = li && li.statusFieldApiName ? li.statusFieldApiName : null;
  const departed = li ? li.statusDepartedValue || 'No longer employed here' : 'No longer employed here';

  const sections = [];

  // Persona
  let persona = 'You are a data quality analyst specializing in CRM contact hygiene';
  if (company) persona += ` for ${company}`;
  if (companyDesc) persona += `, ${companyDesc}`;
  persona += '.';
  sections.push(persona);

  // Task
  let evidence = 'a live web search';
  if (li) evidence += `, plus a LinkedIn "${li.departureValue}" flag`;
  if (zoom) evidence += `${li ? ',' : ','} and simulated ZoomInfo data when present`;
  sections.push(
    `Your task: compare a ${crm} Contact record against external evidence (${evidence}) and identify fields that appear outdated, incorrect, or incomplete.`
  );

  // Snapshot
  sections.push(`CURRENT ${crm.toUpperCase()} CONTACT RECORD (full snapshot):\n{!$RecordSnapshot:Contact.snapshot}`);

  // Listed employer
  sections.push(
    `LISTED EMPLOYER (the firm this contact belongs to in ${crm}):\n{!$Input:Contact.Account.Name}\n` +
      'The employment status is about employment at THIS listed employer. "No longer employed here" means the person has left this specific firm. ' +
      'Departures, layoffs, restructuring, or news about any OTHER company are NOT evidence that this person left the listed employer.'
  );

  // Fields
  const fieldLines = (cfg.fields || []).map((f) => {
    const meaning = f.description || f.label || f.apiName;
    const constraint =
      f.type === 'picklist' && f.restrictedPicklist && f.picklistValues && f.picklistValues.length
        ? `; ONLY these values are valid: ${f.picklistValues.join('; ')}`
        : '';
    return `- ${f.apiName} - ${meaning}${constraint}`;
  });
  sections.push(
    `KEY CONTACT FIELDS TO EVALUATE (${crm} API name - meaning; use these exact API names in suggestions):\n${fieldLines.join('\n')}`
  );

  // Web search
  sections.push(
    'LIVE WEB SEARCH FINDINGS:\n{!$SalesforceDataAction:webSearchStream.webSearchSummary}\n\n' +
      'Use a web result only if it plausibly refers to THIS person (consistent employer, role, or location). ' +
      'If a result likely refers to a different person who shares the name, ignore it. Weigh the most recent information most heavily, ' +
      'and always reason about the person\u2019s CURRENT employer versus the listed employer above.'
  );

  // LinkedIn section
  if (li) {
    const statusClause = statusField
      ? `suggest ${statusField} = "${departed}"`
      : `suggest an employment-status change to "${departed}"`;
    sections.push(
      `LINKEDIN "NOT AT COMPANY" FLAG:\n${li.departureFieldApiName} = {!$Input:Contact.${li.departureFieldApiName}}\n` +
        `- A LinkedIn departure signal exists ONLY IF the value shown above is exactly "${li.departureValue}". If it is blank, empty, or any other value, there is NO LinkedIn departure signal: do not mention LinkedIn, do not claim the person has left, and never invent, assume, or infer this flag.\n` +
        '- When the flag is set, it can be stale or company-specific, so treat it as a prompt to verify, not as proof.\n' +
        `- When the flag IS exactly "${li.departureValue}", decide the status suggestion using web evidence about the LISTED employer:\n` +
        '   - If the web search indicates the person is CURRENTLY at the listed employer, do NOT suggest a status change. Instead, note the conflicting, unverified LinkedIn flag in the OverallAssessment so a human can verify it.\n' +
        `   - If the web search corroborates that the person has LEFT the listed employer, ${statusClause} with confidence 80-95 and cite both the LinkedIn flag and the web evidence.\n` +
        `   - If the web search is silent, returns no relevant results, or only mentions unrelated companies, you MAY still ${statusClause} but at low confidence (about 55). State in the rationale that it is based on the LinkedIn flag alone and requires manual verification. Never treat unrelated-company news as corroboration.`
    );
  }

  // ZoomInfo section
  if (zoom) {
    sections.push(
      'SIMULATED ZOOMINFO DATA (optional; blank until ZoomInfo is installed):\n{!$Input:Contact.Enrichment_Source_Data__c}'
    );
  }

  // Instructions
  let step1 = '1. Compare each key field against the web search findings';
  if (li) step1 += ', the LinkedIn flag (only when set as described above)';
  if (zoom) step1 += ', and any ZoomInfo data';
  step1 += '.';

  let sourceUsage = 'Use Web_Search for anything found via the web search';
  if (li) sourceUsage += `; use LinkedIn only when the flag above is exactly "${li.departureValue}"`;
  if (zoom) sourceUsage += '; use ZoomInfo only for the simulated ZoomInfo data';

  sections.push(
    'INSTRUCTIONS:\n' +
      `${step1}\n` +
      `2. Identify discrepancies where the ${crm} value appears outdated, incorrect, or incomplete.\n` +
      '3. For each discrepancy, produce a suggestion with:\n' +
      '   - Field API name - MUST be one of the exact API names listed above. Do not invent field names.\n' +
      '   - Field label - human-readable label.\n' +
      `   - Current value - the current ${crm} value.\n` +
      '   - Suggested value - the corrected value. For picklist fields the suggested value MUST be one of that field\u2019s exact allowed values; if none fits, do not suggest that field.\n' +
      `   - Source - MUST be one of: ${sources}. ${sourceUsage}.\n` +
      '   - Confidence - integer 1-100 (see guidelines).\n' +
      '   - Rationale - cite the specific evidence (which source and what it said).\n' +
      '   - Category - MUST be one of: Title_Change; Status_Change; Department_Change; Contact_Info; Role_Change; Company_Change; Other.\n' +
      '4. Return up to 5 suggestions, prioritized by confidence and business impact.\n' +
      '5. If no discrepancies are found, set SuggestionCount to "0" and provide an OverallAssessment noting the data appears current.\n' +
      '6. For unused suggestion slots (fewer than 5), leave those fields as empty strings.'
  );

  // Confidence guidelines
  let confidence =
    'CONFIDENCE SCORING GUIDELINES:\n' +
    '- 90-100: multiple independent sources agree, recent, clear evidence\n' +
    '- 70-89: a single clear, specific, recent web result directly about this person\n';
  if (li) confidence += '- About 55: the LinkedIn flag is set but is not corroborated by the web search (needs manual verification)\n';
  confidence += '- 50-69: indirect or older evidence\n- Below 50: speculative - do not include';
  sections.push(confidence);

  // Important guardrails
  const departureEvidence = li
    ? `: either the LinkedIn flag above is exactly "${li.departureValue}", or a web result explicitly indicates the person left the listed employer`
    : ': a web result explicitly indicates the person left the listed employer';
  sections.push(
    'IMPORTANT:\n' +
      '- Only suggest changes supported by genuine evidence. Do not fabricate suggestions or sources.\n' +
      `- Do not suggest an employment-status change to a "departed" value based only on missing, silent, or inconclusive web results. A departure suggestion requires POSITIVE evidence${departureEvidence}. The absence of a web result confirming current employment is NOT evidence of departure.\n` +
      '- Never output a suggestion whose Suggested value equals the Current value when ignoring case, spacing, and punctuation. If you cannot provide a genuinely different, corrected value, omit that suggestion.\n' +
      '- The Suggested value must be the concrete corrected value and must match your rationale.\n' +
      '- Never suggest values containing placeholder or test terms (e.g., "test", "unknown", "tbd", "n/a"); these are often rejected by validation rules.\n' +
      '- Each suggestion must be traceable to specific evidence in the sources above.\n' +
      `- In every generated field (Rationale, OverallAssessment, and any suggested value), refer to this CRM system as "${crm}".`
  );

  return xmlEscape(sections.join('\n\n'));
}

export function buildContext(cfg) {
  const crmName = sanitizeDisplay(cfg.crmName || 'Salesforce');
  const linkedInEnabled = !!(cfg.linkedIn && cfg.linkedIn.enabled);
  const fields = cfg.fields || [];

  let statusFieldLabel = 'Status';
  if (linkedInEnabled && cfg.linkedIn.statusFieldApiName) {
    const match = fields.find((f) => f.apiName === cfg.linkedIn.statusFieldApiName);
    if (match && match.label) statusFieldLabel = match.label;
  }

  return {
    crmName,
    companyName: sanitizeDisplay(cfg.companyName || ''),
    // Opaque version identifier for the prompt template. It must be present and
    // consistent (activeVersionIdentifier === versionIdentifier) so the template
    // ships Published and the screen flow can bind to its structured response.
    promptVersionIdentifier: cfg.promptVersionIdentifier || 'rzB+EdwPrpSntZqngMWF7WcvIRy5RhjODh3DmUsOFtA=_4',
    webSearchProvider: cfg.webSearchProvider || 'openai',
    webSearchQuery: cfg.webSearchQuery || DEFAULT_WEB_SEARCH_QUERY,
    promptContent: buildPromptContent(cfg),
    fields,
    customWriteBackFields: fields.filter((f) => f.custom),
    sources: cfg.sources || [],
    linkedIn: linkedInEnabled
      ? {
          enabled: true,
          departureFieldApiName: cfg.linkedIn.departureFieldApiName,
          departureValue: cfg.linkedIn.departureValue || 'Not at Company',
          statusFieldApiName: cfg.linkedIn.statusFieldApiName || '',
          statusFieldLabel,
          statusDepartedValue: cfg.linkedIn.statusDepartedValue || 'No longer employed here'
        }
      : { enabled: false },
    zoomInfo: { simulationField: !!(cfg.zoomInfo && cfg.zoomInfo.simulationField) },
    options: {
      includeAutoCaptureFlow: !!(cfg.options && cfg.options.includeAutoCaptureFlow),
      includeDemoPage: !(cfg.options && cfg.options.includeDemoPage === false),
      includeRetentionJob: !(cfg.options && cfg.options.includeRetentionJob === false)
    }
  };
}
