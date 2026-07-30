#!/usr/bin/env node
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inspect } from './inspect.js';
import { configure } from './configure.js';
import { generate } from './generate.js';
import { sfStream, resolveTargetOrg } from './lib/sfClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_FORCE_APP = path.join(ROOT, 'generated', 'force-app');
const DEFAULT_ROOT = path.join(OUT_FORCE_APP, 'main', 'default');

// The screen flow binds to the prompt template's structured response, so the
// prompt template + its Lightning type + the suggestion object must exist in the
// org before the flow is validated. We deploy those first, then everything else.
const PHASE1_DIRS = ['objects', 'lightningTypes', 'genAiPromptTemplates'].map((d) => path.join(DEFAULT_ROOT, d));

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-validate') args.validate = false;
    else if (a === '--org' || a === '-o') args.org = argv[++i];
    else if (a === '--config' || a === '-c') args.config = argv[++i];
    else if (a === '--test-level' || a === '-l') args.testLevel = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else args._.push(a);
  }
  return args;
}

const HELP = `Contact Enrichment Accelerator

Usage: enrich <command> [options]

Commands:
  inspect     Describe the connected org, detect reusable fields + enrichment
              signals, and write a reuse-vs-create report + starter config.
  configure   Interactive wizard to finalize the config (CRM name, fields,
              sources, LinkedIn/ZoomInfo, options).
  generate    Render the tailored package into generated/ and dry-run validate.
  deploy      Deploy the generated package and assign permission sets.

Options:
  -o, --org <alias>        Target org (defaults to your sf default org).
  -c, --config <path>      Config file (default: config/enrichment.config.json).
      --no-validate        Skip the deploy dry-run in \`generate\`.
  -l, --test-level <lvl>   Apex test level for deploy (default: NoTestRun).
  -h, --help               Show this help.

Typical flow:
  npm run inspect -- --org myOrg
  npm run configure
  npm run generate -- --org myOrg
  npm run deploy -- --org myOrg
`;

async function deploy(args) {
  if (!existsSync(OUT_FORCE_APP)) {
    throw new Error('No generated package found. Run `npm run generate` first.');
  }
  const org = await resolveTargetOrg(args.org);
  const testLevel = args.testLevel || 'NoTestRun';

  // Phase 1: prompt template + Lightning type + object (dependencies of the flow).
  console.log(`Phase 1/2: deploying prompt template, Lightning type, and object to ${org} ...`);
  const phase1Args = ['project', 'deploy', 'start', '-o', org, '--wait', '30'];
  for (const dir of PHASE1_DIRS) phase1Args.push('-d', dir);
  const code1 = await sfStream(phase1Args);
  if (code1 !== 0) {
    process.exitCode = code1;
    console.log('\nPhase 1 deploy failed (see output above).');
    return;
  }

  // Phase 2: everything else (flow can now bind to the prompt's structured response).
  console.log(`\nPhase 2/2: deploying the full package to ${org} (test level: ${testLevel}) ...`);
  const code = await sfStream([
    'project', 'deploy', 'start',
    '-d', OUT_FORCE_APP,
    '-o', org,
    '--test-level', testLevel,
    '--wait', '30'
  ]);
  if (code !== 0) {
    process.exitCode = code;
    console.log('\nDeploy failed (see output above).');
    return;
  }

  console.log(`\nAssigning permission set Contact_Enrichment_Admin to the running user ...`);
  await sfStream(['org', 'assign', 'permset', '-n', 'Contact_Enrichment_Admin', '-o', org]);

  console.log('\nDeploy complete. Post-install steps:');
  console.log('  - Assign Contact_Enrichment_Rep / Contact_Enrichment_Admin to your users.');
  console.log('  - Publish/activate the "Contact Enrichment Analysis" prompt template in Prompt Builder.');
  console.log('  - Add the Contact Enrichment Widget to a Contact record page (or activate the demo page).');
  console.log('  See docs/post-install.md for details.');
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const command = args._[0];

  if (args.help || !command) {
    console.log(HELP);
    return;
  }

  switch (command) {
    case 'inspect':
      await inspect({ org: args.org });
      break;
    case 'configure':
      await configure();
      break;
    case 'generate':
      await generate({ config: args.config, org: args.org, validate: args.validate !== false });
      break;
    case 'deploy':
      await deploy(args);
      break;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('\nError: ' + (err && err.message ? err.message : err));
  process.exitCode = 1;
});
