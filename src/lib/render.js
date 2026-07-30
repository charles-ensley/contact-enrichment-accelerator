import { readdirSync, statSync, readFileSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import Handlebars from 'handlebars';

/** Recursively list every file under a directory (absolute paths). */
export function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/**
 * Decide whether a template file should be excluded from the generated package
 * based on the customer's options/signals. `rel` is POSIX-style relative to the
 * template force-app root.
 */
export function shouldSkip(rel, ctx) {
  const p = rel.replace(/\\/g, '/');

  if (p.includes('Contact_Enrichment_Auto_Capture_LinkedIn_Departure.flow-meta.xml')) {
    return !(ctx.options.includeAutoCaptureFlow && ctx.linkedIn.enabled);
  }
  if (p.includes('objects/Contact/fields/Enrichment_Source_Data__c.field-meta.xml')) {
    return !ctx.zoomInfo.simulationField;
  }
  if (p.includes('flexipages/Contact_Enrichment_Demo_Page.flexipage-meta.xml')) {
    return !ctx.options.includeDemoPage;
  }
  if (/classes\/ContactEnrichmentRetentionJob(Test)?\.cls(-meta\.xml)?$/.test(p)) {
    return !ctx.options.includeRetentionJob;
  }
  return false;
}

export function renderString(content, ctx) {
  const template = Handlebars.compile(content, { noEscape: false });
  return template(ctx);
}

/**
 * Render the template force-app tree into the output directory, skipping
 * conditional components. Returns the list of written relative paths.
 */
export function renderTree(templateRoot, outRoot, ctx) {
  if (existsSync(outRoot)) rmSync(outRoot, { recursive: true, force: true });
  mkdirSync(outRoot, { recursive: true });

  const written = [];
  for (const abs of walk(templateRoot)) {
    const rel = path.relative(templateRoot, abs);
    if (shouldSkip(rel, ctx)) continue;

    const raw = readFileSync(abs, 'utf8');
    const rendered = renderString(raw, ctx);

    const dest = path.join(outRoot, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, rendered, 'utf8');
    written.push(rel.replace(/\\/g, '/'));
  }
  return written;
}
