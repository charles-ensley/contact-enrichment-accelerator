import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sfJson, describeSObject, listMetadata, resolveTargetOrg } from './lib/sfClient.js';
import { analyzeContact, detectCollisions } from './lib/describe.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const DEFAULT_WEB_SEARCH_QUERY =
  '{!$Input:Contact.Name} {!$Input:Contact.Account.Name} current employer and job title - latest role or departure news';

async function getOrgName(org) {
  try {
    const res = await sfJson(['data', 'query', '--query', 'SELECT Name FROM Organization LIMIT 1', '--target-org', org]);
    return res.records && res.records[0] ? res.records[0].Name : '';
  } catch {
    return '';
  }
}

function buildStarterConfig(analysis, orgName) {
  const sources = ['Web_Search', 'Company_Website', 'News', 'Internal_Analysis'];
  if (analysis.linkedIn) sources.splice(1, 0, 'LinkedIn');
  if (analysis.zoomInfo.present) sources.push('ZoomInfo');

  const statusField = analysis.statusPicklists[0];
  const departedValue = statusField
    ? statusField.picklistValues.find((v) => /no longer|left|former/i.test(v)) || 'No longer employed here'
    : 'No longer employed here';

  const fields = (analysis.recommended.length ? analysis.recommended : analysis.candidates.slice(0, 8)).map((f) => ({
    apiName: f.apiName,
    label: f.label,
    type: f.type,
    description: defaultDescription(f),
    custom: f.custom,
    ...(f.type === 'picklist'
      ? { restrictedPicklist: f.restrictedPicklist, picklistValues: f.picklistValues }
      : {})
  }));

  const config = {
    companyName: orgName || '',
    companyDescription: '',
    crmName: 'Salesforce',
    targetObject: 'Contact',
    webSearchProvider: 'openai',
    webSearchQuery: DEFAULT_WEB_SEARCH_QUERY,
    fields,
    sources,
    linkedIn: analysis.linkedIn
      ? {
          enabled: true,
          departureFieldApiName: analysis.linkedIn.fieldApiName,
          departureValue: analysis.linkedIn.departureValue,
          statusFieldApiName: statusField ? statusField.apiName : '',
          statusDepartedValue: departedValue
        }
      : { enabled: false },
    zoomInfo: { simulationField: false },
    options: {
      includeAutoCaptureFlow: !!(analysis.linkedIn && statusField),
      includeDemoPage: true,
      includeRetentionJob: true
    }
  };
  return config;
}

function defaultDescription(f) {
  const map = {
    Title: 'job title (free text)',
    Department: 'department (free text)',
    Email: 'business email',
    Phone: 'business phone',
    MobilePhone: 'mobile phone',
    MailingCity: 'city',
    MailingState: 'state/province'
  };
  return map[f.apiName] || f.label;
}

function buildReport(org, orgName, analysis, collisions) {
  const lines = [];
  lines.push(`# Contact Enrichment - Org Inspection Report`);
  lines.push('');
  lines.push(`- **Org:** ${org}${orgName ? ` (${orgName})` : ''}`);
  lines.push(`- **Generated:** ${new Date().toISOString()}`);
  lines.push('');

  lines.push('## Enrichment signals detected');
  lines.push('');
  lines.push('| Signal | Status | Detail |');
  lines.push('| --- | --- | --- |');
  lines.push(`| Web Search (Search the Web data action) | Assumed available | Requires Einstein / Prompt Builder enabled and the \`openai\` provider allowed in the Trust Layer |`);
  lines.push(
    `| LinkedIn "no longer at company" | ${analysis.linkedIn ? 'FOUND' : 'not found'} | ${
      analysis.linkedIn ? `\`${analysis.linkedIn.fieldApiName}\` (departure value: "${analysis.linkedIn.departureValue}")` : 'No matching field; LinkedIn source will be omitted'
    } |`
  );
  lines.push(
    `| ZoomInfo | ${analysis.zoomInfo.present ? 'FOUND' : 'not found'} | ${
      analysis.zoomInfo.present ? analysis.zoomInfo.fields.map((f) => `\`${f}\``).join(', ') : 'Not installed; you can enable the transient simulation scaffold instead'
    } |`
  );
  lines.push('');

  lines.push('## Reuse vs. create');
  lines.push('');
  lines.push('### Reuse (already in the org)');
  lines.push('');
  if (collisions.length) {
    lines.push('These package component names already exist. Review before deploying - you may be reusing or overwriting them:');
    lines.push('');
    for (const c of collisions) lines.push(`- \`${c.type}\`: **${c.name}**`);
  } else {
    lines.push('None of the accelerator component names already exist - this will be a clean install.');
  }
  lines.push('');
  lines.push('Write-back target fields are **reused** from the org (never recreated). The AI is constrained to the API names you select below.');
  lines.push('');

  lines.push('### Create (deployed by the accelerator)');
  lines.push('');
  lines.push('- Custom object `Contact_Enrichment_Suggestion__c` (+ fields, list views, tab)');
  lines.push('- Contact workflow fields: `Enrichment_Status__c`, `Last_Enrichment_Check__c`, `Pending_Enrichment_Count__c`');
  lines.push('- Prompt template `Contact_Enrichment_Analysis` + Lightning type `ContactEnrichmentOutput`');
  lines.push('- Screen flow `Generate_Contact_Enrichment_Suggestions` + LWC `contactEnrichmentWidget`');
  lines.push('- Apex `ContactEnrichmentController` (+ retention job) and permission sets Rep / Admin');
  lines.push('');

  lines.push('## Candidate write-back fields');
  lines.push('');
  lines.push('Recommended defaults are marked. Refine the selection and picklist values with `enrich configure`.');
  lines.push('');
  lines.push('| API Name | Label | Type | Custom | Restricted picklist | Recommended |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  const recNames = new Set(analysis.recommended.map((r) => r.apiName));
  for (const c of analysis.candidates) {
    lines.push(
      `| \`${c.apiName}\` | ${c.label} | ${c.type} | ${c.custom ? 'yes' : 'no'} | ${c.restrictedPicklist ? 'yes' : 'no'} | ${recNames.has(c.apiName) ? 'YES' : ''} |`
    );
  }
  lines.push('');
  lines.push(`_${analysis.candidates.length} candidate field(s) found._`);
  lines.push('');

  lines.push('## Next steps');
  lines.push('');
  lines.push('1. `npm run configure` - refine the CRM name, fields, picklist values, sources, and options.');
  lines.push('2. `npm run generate` - render the tailored package into `generated/` and dry-run validate.');
  lines.push('3. `npm run deploy` - deploy and assign permission sets.');
  lines.push('');
  return lines.join('\n');
}

export async function inspect({ org: orgArg } = {}) {
  const org = await resolveTargetOrg(orgArg);
  console.log(`Inspecting Contact metadata in org: ${org} ...`);

  const describe = await describeSObject('Contact', org);
  const orgName = await getOrgName(org);

  const listsByType = {};
  for (const type of ['CustomObject', 'Flow', 'GenAiPromptTemplate', 'LightningComponentBundle', 'ApexClass', 'PermissionSet']) {
    listsByType[type] = await listMetadata(type, org);
  }

  const analysis = analyzeContact(describe);
  const collisions = detectCollisions(listsByType);

  const report = buildReport(org, orgName, analysis, collisions);
  const config = buildStarterConfig(analysis, orgName);

  const reportsDir = path.join(ROOT, 'reports');
  const configDir = path.join(ROOT, 'config');
  mkdirSync(reportsDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });

  const safeOrg = org.replace(/[^a-zA-Z0-9._-]/g, '_');
  const reportPath = path.join(reportsDir, `inspection-${safeOrg}.md`);
  const configPath = path.join(configDir, 'enrichment.config.json');

  writeFileSync(reportPath, report, 'utf8');

  const configExisted = existsSync(configPath);
  if (configExisted) {
    const backup = path.join(configDir, 'enrichment.config.previous.json');
    writeFileSync(backup, readFileSync(configPath, 'utf8'), 'utf8');
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');

  console.log('');
  console.log(`Report written:        ${path.relative(ROOT, reportPath)}`);
  console.log(`Starter config written: ${path.relative(ROOT, configPath)}${configExisted ? ' (previous backed up)' : ''}`);
  console.log('');
  console.log('Signals:');
  console.log(`  LinkedIn departure field: ${analysis.linkedIn ? analysis.linkedIn.fieldApiName : 'not found'}`);
  console.log(`  ZoomInfo fields:          ${analysis.zoomInfo.present ? analysis.zoomInfo.fields.join(', ') : 'not found'}`);
  console.log(`  Candidate fields:         ${analysis.candidates.length}`);
  if (collisions.length) {
    console.log(`  Naming collisions:        ${collisions.length} (see report)`);
  }
  console.log('');
  console.log('Next: npm run configure');
  return { reportPath, configPath, analysis, collisions };
}
