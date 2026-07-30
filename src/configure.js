import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import prompts from 'prompts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config', 'enrichment.config.json');
const EXAMPLE_PATH = path.join(ROOT, 'config', 'enrichment.config.example.json');

const SOURCE_CHOICES = ['Web_Search', 'LinkedIn', 'ZoomInfo', 'Company_Website', 'News', 'Internal_Analysis'];

function loadConfig() {
  if (existsSync(CONFIG_PATH)) return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  console.log('No config/enrichment.config.json found - starting from the example. (Tip: run `npm run inspect` first to pre-fill from your org.)');
  return JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8'));
}

function onCancel() {
  console.log('\nConfiguration cancelled - no changes written.');
  process.exit(1);
}

export async function configure() {
  const cfg = loadConfig();
  const li = cfg.linkedIn || { enabled: false };
  const zoom = cfg.zoomInfo || { simulationField: false };
  const options = cfg.options || {};

  console.log('Contact Enrichment - configuration wizard\n');

  const basics = await prompts(
    [
      { type: 'text', name: 'companyName', message: 'Customer company name (used in the AI prompt persona)', initial: cfg.companyName || '' },
      { type: 'text', name: 'companyDescription', message: 'One-line company/industry description (optional)', initial: cfg.companyDescription || '' },
      { type: 'text', name: 'crmName', message: 'CRM display name (usually "Salesforce")', initial: cfg.crmName || 'Salesforce' },
      { type: 'text', name: 'webSearchQuery', message: 'Web search query expression', initial: cfg.webSearchQuery || '' }
    ],
    { onCancel }
  );

  const fieldChoices = (cfg.fields || []).map((f) => ({
    title: `${f.apiName}  (${f.type}${f.custom ? ', custom' : ''})`,
    value: f.apiName,
    selected: true
  }));

  const { keptFields } = fieldChoices.length
    ? await prompts(
        {
          type: 'multiselect',
          name: 'keptFields',
          message: 'Write-back fields the AI may suggest (space to toggle)',
          choices: fieldChoices,
          hint: '- add more by editing config/enrichment.config.json',
          instructions: false
        },
        { onCancel }
      )
    : { keptFields: [] };

  const { sources } = await prompts(
    {
      type: 'multiselect',
      name: 'sources',
      message: 'Allowed suggestion sources',
      choices: SOURCE_CHOICES.map((s) => ({ title: s, value: s, selected: (cfg.sources || []).includes(s) })),
      instructions: false
    },
    { onCancel }
  );

  const { enableLinkedIn } = await prompts(
    {
      type: 'toggle',
      name: 'enableLinkedIn',
      message: 'Enable the LinkedIn "no longer at company" signal?',
      initial: !!li.enabled,
      active: 'yes',
      inactive: 'no'
    },
    { onCancel }
  );

  let linkedIn = { enabled: false };
  if (enableLinkedIn) {
    const liAns = await prompts(
      [
        { type: 'text', name: 'departureFieldApiName', message: 'Departure flag field API name', initial: li.departureFieldApiName || 'LID__No_longer_at_Company__c' },
        { type: 'text', name: 'departureValue', message: 'Value that means "departed"', initial: li.departureValue || 'Not at Company' },
        { type: 'text', name: 'statusFieldApiName', message: 'Employment status field API name (optional)', initial: li.statusFieldApiName || '' },
        { type: 'text', name: 'statusDepartedValue', message: 'Status value meaning "left this employer"', initial: li.statusDepartedValue || 'No longer employed here' }
      ],
      { onCancel }
    );
    linkedIn = { enabled: true, ...liAns };
  }

  const { simulationField, includeDemoPage, includeRetentionJob } = await prompts(
    [
      {
        type: 'toggle',
        name: 'simulationField',
        message: 'Include the ZoomInfo simulation scaffold (demo a paid provider before install)?',
        initial: !!zoom.simulationField,
        active: 'yes',
        inactive: 'no'
      },
      {
        type: 'toggle',
        name: 'includeDemoPage',
        message: 'Include a clean demo Lightning record page?',
        initial: options.includeDemoPage !== false,
        active: 'yes',
        inactive: 'no'
      },
      {
        type: 'toggle',
        name: 'includeRetentionJob',
        message: 'Include the data-retention purge job?',
        initial: options.includeRetentionJob !== false,
        active: 'yes',
        inactive: 'no'
      }
    ],
    { onCancel }
  );

  let includeAutoCaptureFlow = false;
  if (enableLinkedIn) {
    const ans = await prompts(
      {
        type: 'toggle',
        name: 'includeAutoCaptureFlow',
        message: 'Include the (inactive) LinkedIn auto-capture flow?',
        initial: options.includeAutoCaptureFlow !== false,
        active: 'yes',
        inactive: 'no'
      },
      { onCancel }
    );
    includeAutoCaptureFlow = ans.includeAutoCaptureFlow;
  }

  const kept = new Set(keptFields);
  const next = {
    ...cfg,
    companyName: basics.companyName,
    companyDescription: basics.companyDescription,
    crmName: basics.crmName || 'Salesforce',
    targetObject: 'Contact',
    webSearchProvider: cfg.webSearchProvider || 'openai',
    webSearchQuery: basics.webSearchQuery || cfg.webSearchQuery,
    fields: (cfg.fields || []).filter((f) => kept.has(f.apiName)),
    sources: sources && sources.length ? sources : cfg.sources,
    linkedIn,
    zoomInfo: { simulationField },
    options: { includeAutoCaptureFlow, includeDemoPage, includeRetentionJob }
  };

  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');
  console.log(`\nSaved: ${path.relative(ROOT, CONFIG_PATH)}`);
  console.log('Next: npm run generate');
  return next;
}
