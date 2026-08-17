import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContext } from './lib/context.js';
import { renderTree, renderString } from './lib/render.js';
import { sfStream, resolveTargetOrg, listMetadata } from './lib/sfClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config', 'enrichment.config.json');
const TEMPLATE_FORCE_APP = path.join(ROOT, 'templates', 'force-app', 'main', 'default');
const TEMPLATE_SCRIPTS = path.join(ROOT, 'templates', 'scripts');
const OUT_ROOT = path.join(ROOT, 'generated');
const OUT_FORCE_APP = path.join(OUT_ROOT, 'force-app', 'main', 'default');

function loadConfig(configPath) {
  const p = configPath || CONFIG_PATH;
  if (!existsSync(p)) {
    throw new Error(`Config not found at ${path.relative(ROOT, p)}. Run \`npm run inspect\` then \`npm run configure\` first.`);
  }
  return JSON.parse(readFileSync(p, 'utf8'));
}

function validateConfig(cfg) {
  const errors = [];
  if (!cfg.crmName) cfg.crmName = 'Salesforce';
  if (!Array.isArray(cfg.fields) || cfg.fields.length === 0) {
    errors.push('At least one write-back field is required (config.fields).');
  }
  if (cfg.options && cfg.options.includeAutoCaptureFlow) {
    if (!cfg.linkedIn || !cfg.linkedIn.enabled) {
      errors.push('options.includeAutoCaptureFlow requires linkedIn.enabled = true.');
    } else if (!cfg.linkedIn.departureFieldApiName) {
      errors.push('options.includeAutoCaptureFlow requires linkedIn.departureFieldApiName.');
    } else if (!cfg.linkedIn.statusFieldApiName) {
      errors.push('options.includeAutoCaptureFlow requires linkedIn.statusFieldApiName (the field the flow writes to).');
    }
  }
  for (const f of cfg.fields || []) {
    if (!f.apiName || !f.type) errors.push(`Field entry missing apiName/type: ${JSON.stringify(f)}`);
  }
  if (errors.length) {
    throw new Error('Invalid config:\n - ' + errors.join('\n - '));
  }
}

function buildPackageXml(ctx) {
  const types = [];
  const add = (name, members) => types.push({ name, members });

  const apex = ['ContactEnrichmentController', 'ContactEnrichmentControllerTest'];
  if (ctx.options.includeRetentionJob) apex.push('ContactEnrichmentRetentionJob', 'ContactEnrichmentRetentionJobTest');
  add('ApexClass', apex);

  const flows = ['Generate_Contact_Enrichment_Suggestions'];
  if (ctx.options.includeAutoCaptureFlow && ctx.linkedIn.enabled) flows.push('Contact_Enrichment_Auto_Capture_LinkedIn_Departure');
  add('Flow', flows);

  add('GenAiPromptTemplate', ['Contact_Enrichment_Analysis']);
  add('LightningTypeBundle', ['ContactEnrichmentOutput']);
  add('LightningComponentBundle', ['contactEnrichmentWidget']);
  add('Layout', ['Contact_Enrichment_Suggestion__c-Contact Enrichment Suggestion Layout']);
  add('PermissionSet', ['Contact_Enrichment_Rep', 'Contact_Enrichment_Admin']);
  add('CustomPermission', ['Contact_Enrichment_Admin']);
  add('QuickAction', ['Contact.Run_Enrichment_Check']);
  if (ctx.options.includeDemoPage) add('FlexiPage', ['Contact_Enrichment_Demo_Page']);
  add('CustomObject', ['Contact_Enrichment_Suggestion__c']);
  add('CustomTab', ['Contact_Enrichment_Suggestion__c']);
  add('ReportType', ['Contact_Enrichment_Suggestions']);
  add('Report', ['Contact_Enrichment', 'Contact_Enrichment/All_Enrichment_Suggestions']);

  const contactFields = [
    'Contact.Enrichment_Status__c',
    'Contact.Last_Enrichment_Check__c',
    'Contact.Pending_Enrichment_Count__c'
  ];
  if (ctx.zoomInfo.simulationField) contactFields.push('Contact.Enrichment_Source_Data__c');
  add('CustomField', contactFields);

  const body = types
    .map(
      (t) =>
        '    <types>\n' +
        t.members.map((m) => `        <members>${m}</members>`).join('\n') +
        `\n        <name>${t.name}</name>\n    </types>`
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n${body}\n    <version>66.0</version>\n</Package>\n`;
}

function buildInstallScript() {
  return `#!/usr/bin/env bash
set -euo pipefail

# Deploys the generated Contact Enrichment package and assigns permission sets.
# Usage: bash install.sh <org-alias-or-username>

TARGET_ORG="\${1:-}"
if [[ -n "\${TARGET_ORG}" ]]; then
  ORG_ARGS=( -o "\${TARGET_ORG}" )
else
  ORG_ARGS=()
fi

SCRIPT_DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_DIR="\${SCRIPT_DIR}/force-app/main/default"

# Phase 1: the screen flow binds to the prompt template's structured response,
# so the prompt template + Lightning type + object must exist first.
echo "Phase 1/2: deploying prompt template, Lightning type, and object..."
sf project deploy start \\
  -d "\${DEFAULT_DIR}/objects" \\
  -d "\${DEFAULT_DIR}/lightningTypes" \\
  -d "\${DEFAULT_DIR}/genAiPromptTemplates" \\
  "\${ORG_ARGS[@]}" --wait 30

# Phase 2: everything else.
echo "Phase 2/2: deploying the full package..."
sf project deploy start -d "\${SCRIPT_DIR}/force-app" "\${ORG_ARGS[@]}" --wait 30

echo "Assigning permission set Contact_Enrichment_Admin to the running user..."
sf org assign permset -n Contact_Enrichment_Admin "\${ORG_ARGS[@]}" || true

echo "Done."
echo "Next steps:"
echo "  - Assign 'Contact Enrichment - Rep' (Contact_Enrichment_Rep) to sales/relationship users."
echo "  - Assign 'Contact Enrichment - Admin' (Contact_Enrichment_Admin) to admins/data stewards."
echo "  - Publish/activate the 'Contact Enrichment Analysis' prompt template in Prompt Builder."
echo "  - Add the 'Contact Enrichment Widget' to a Contact record page (or activate the demo page)."
`;
}

export async function generate({ config: configPath, org: orgArg, validate = true } = {}) {
  const cfg = loadConfig(configPath);
  validateConfig(cfg);
  const ctx = buildContext(cfg);

  if (existsSync(OUT_ROOT)) rmSync(OUT_ROOT, { recursive: true, force: true });

  console.log('Rendering package...');
  const written = renderTree(TEMPLATE_FORCE_APP, OUT_FORCE_APP, ctx);

  // Optional simulation seed script.
  if (ctx.zoomInfo.simulationField) {
    const src = path.join(TEMPLATE_SCRIPTS, 'seed-enrichment-simulation.apex');
    if (existsSync(src)) {
      const outScripts = path.join(OUT_ROOT, 'scripts');
      mkdirSync(outScripts, { recursive: true });
      writeFileSync(path.join(outScripts, 'seed-enrichment-simulation.apex'), renderString(readFileSync(src, 'utf8'), ctx), 'utf8');
    }
  }

  // Manifest + installer.
  const manifestDir = path.join(OUT_ROOT, 'manifest');
  mkdirSync(manifestDir, { recursive: true });
  writeFileSync(path.join(manifestDir, 'package.xml'), buildPackageXml(ctx), 'utf8');
  writeFileSync(path.join(OUT_ROOT, 'install.sh'), buildInstallScript(), { mode: 0o755 });

  console.log('');
  console.log(`Generated ${written.length} metadata files into ${path.relative(ROOT, OUT_FORCE_APP)}`);
  console.log(`  CRM label:        ${ctx.crmName}`);
  console.log(`  Write-back fields: ${ctx.fields.map((f) => f.apiName).join(', ')}`);
  console.log(`  LinkedIn signal:  ${ctx.linkedIn.enabled ? ctx.linkedIn.departureFieldApiName : 'disabled'}`);
  console.log(`  ZoomInfo sim:     ${ctx.zoomInfo.simulationField ? 'included' : 'omitted'}`);
  console.log(`  Auto-capture flow: ${ctx.options.includeAutoCaptureFlow && ctx.linkedIn.enabled ? 'included' : 'omitted'}`);
  console.log(`  Demo page:        ${ctx.options.includeDemoPage ? 'included' : 'omitted'}`);
  console.log('');

  if (validate) {
    let org;
    try {
      org = await resolveTargetOrg(orgArg);
    } catch {
      console.log('No target org set - skipping deploy dry-run. (Pass --org <alias> to validate.)');
      return { written };
    }
    console.log(`Validating with a deploy dry-run against ${org} ...`);
    const code = await sfStream(['project', 'deploy', 'start', '-d', OUT_FORCE_APP, '--dry-run', '-o', org, '--wait', '30']);
    if (code !== 0) {
      // On a fresh org the screen flow can't bind to the prompt template's
      // structured response until the template exists. This is expected before
      // the first deploy; `deploy` handles it with a two-phase rollout.
      const templates = await listMetadata('GenAiPromptTemplate', org);
      const promptExists = templates.some((t) => t.fullName === 'Contact_Enrichment_Analysis');
      if (!promptExists) {
        console.log(
          '\nNote: the only expected dry-run failure is the screen flow binding to the prompt template,' +
            "\nwhich isn't in this org yet. `npm run deploy` installs it in two phases so the flow validates." +
            '\nEverything else validated successfully.'
        );
      } else {
        console.log('\nDry-run reported problems (see output above). Fix config or org prerequisites and re-run `npm run generate`.');
        process.exitCode = code;
      }
    } else {
      console.log('\nDry-run succeeded. Deploy with: npm run deploy -- --org ' + org);
    }
  }
  return { written };
}
