import { spawn } from 'node:child_process';

/**
 * Thin wrapper around the Salesforce CLI (`sf`).
 *
 * Every call adds `--json` and parses the structured `{ status, result }`
 * envelope so the rest of the tool works with plain objects.
 */

function run(args, { cwd, inheritStdio = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('sf', args, {
      cwd,
      stdio: inheritStdio ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      shell: false
    });

    let stdout = '';
    let stderr = '';
    if (!inheritStdio) {
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
    }

    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(new Error('The Salesforce CLI (`sf`) was not found on your PATH. Install it from https://developer.salesforce.com/tools/salesforcecli'));
      } else {
        reject(err);
      }
    });

    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

/** Run an `sf` command with --json and return the parsed `result`. Throws on failure. */
export async function sfJson(args, opts = {}) {
  const fullArgs = args.includes('--json') ? args : [...args, '--json'];
  const { code, stdout, stderr } = await run(fullArgs, opts);

  let parsed;
  try {
    parsed = JSON.parse(stdout || stderr || '{}');
  } catch {
    if (code !== 0) {
      throw new Error(`sf ${args.join(' ')} failed (exit ${code}).\n${stderr || stdout}`);
    }
    throw new Error(`Could not parse JSON from: sf ${args.join(' ')}\n${stdout}`);
  }

  if (parsed.status !== 0) {
    const msg = parsed.message || parsed.name || `sf ${args.join(' ')} failed`;
    throw new Error(msg);
  }
  return parsed.result;
}

/** Stream an `sf` command straight to the terminal (for deploys). Returns exit code. */
export async function sfStream(args, opts = {}) {
  const { code } = await run(args, { ...opts, inheritStdio: true });
  return code;
}

/** Resolve the username/alias that will be targeted (explicit alias or the default org). */
export async function resolveTargetOrg(alias) {
  if (alias) return alias;
  try {
    const result = await sfJson(['config', 'get', 'target-org']);
    const entry = Array.isArray(result) ? result[0] : result;
    if (entry && entry.value) return entry.value;
  } catch {
    /* fall through */
  }
  throw new Error('No target org specified and no default org is set. Pass --org <alias> or run `sf config set target-org <alias>`.');
}

/** Describe an SObject (fields, picklist values, etc.). */
export function describeSObject(sobject, org) {
  return sfJson(['sobject', 'describe', '--sobject', sobject, '--target-org', org]);
}

/** List metadata components of a given type in the org. Returns [] on error. */
export async function listMetadata(type, org) {
  try {
    const result = await sfJson(['org', 'list', 'metadata', '--metadata-type', type, '--target-org', org]);
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}
