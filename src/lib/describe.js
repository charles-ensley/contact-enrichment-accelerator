/**
 * Interpret a Contact `sobject describe` into the pieces the accelerator needs:
 * candidate write-back fields, LinkedIn / ZoomInfo enrichment signals, and a
 * starter list of recommended fields.
 */

// Salesforce describe types that the Apex accept-writer can safely write from text.
const TEXT_LIKE = new Set(['string', 'textarea', 'picklist', 'combobox', 'url', 'email', 'phone', 'encryptedstring']);

// Fields that are never useful enrichment targets even though they are text-like.
const DENYLIST = new Set([
  'Id', 'Name', 'FirstName', 'LastName', 'Salutation', 'OwnerId', 'AccountId',
  'CreatedById', 'LastModifiedById', 'MasterRecordId', 'IsDeleted', 'Jigsaw',
  'CleanStatus', 'PhotoUrl', 'IndividualId'
]);

// Standard Contact fields we recommend selecting by default when present.
const RECOMMENDED_STANDARD = [
  'Title', 'Department', 'Email', 'Phone', 'MobilePhone', 'MailingCity', 'MailingState'
];

export function simplifyType(describeType) {
  const t = String(describeType || '').toLowerCase();
  if (t === 'multipicklist') return 'picklist';
  if (TEXT_LIKE.has(t)) return t === 'encryptedstring' ? 'string' : t;
  return null; // not a supported write-back type
}

/** Return true if a field looks like the LinkedIn Sales Navigator "no longer at company" flag. */
function isLinkedInDepartureField(f) {
  const n = f.name.toLowerCase();
  if (/no.?longer.?at.?company/.test(n)) return true;
  if (n.startsWith('lid__') && /company/.test(n)) return true;
  return false;
}

/** Guess the value that signals a departure from a picklist field. */
function guessDepartureValue(field) {
  const values = (field.picklistValues || []).filter((v) => v.active !== false).map((v) => v.value);
  const notAt = values.find((v) => /not at company/i.test(v));
  if (notAt) return notAt;
  return values[0] || 'Not at Company';
}

function isZoomInfoField(f) {
  const n = f.name.toLowerCase();
  return /zoominfo/.test(n) || /^zi_/.test(n) || /__zi_/.test(n) || n.includes('zoom_info');
}

/**
 * @param {object} describe - result of `sf sobject describe`
 * @returns {{ candidates, recommended, linkedIn, zoomInfo, statusPicklists }}
 */
export function analyzeContact(describe) {
  const fields = describe.fields || [];
  const candidates = [];
  let linkedIn = null;
  const zoomInfoFields = [];
  const statusPicklists = [];

  for (const f of fields) {
    if (isLinkedInDepartureField(f)) {
      linkedIn = {
        fieldApiName: f.name,
        label: f.label,
        departureValue: guessDepartureValue(f),
        values: (f.picklistValues || []).map((v) => v.value)
      };
    }
    if (isZoomInfoField(f)) {
      zoomInfoFields.push(f.name);
    }

    if (DENYLIST.has(f.name)) continue;
    const type = simplifyType(f.type);
    if (!type) continue;
    if (!f.updateable) continue;

    const entry = {
      apiName: f.name,
      label: f.label,
      type,
      custom: !!f.custom,
      restrictedPicklist: !!f.restrictedPicklist,
      picklistValues: (f.picklistValues || []).filter((v) => v.active !== false).map((v) => v.value)
    };
    candidates.push(entry);

    // A restricted picklist whose values include a departure/retired concept is a
    // good "employment status" target for the LinkedIn auto-capture flow.
    if (type === 'picklist' && entry.picklistValues.some((v) => /(retired|no longer|deceased|inactive|left)/i.test(v))) {
      statusPicklists.push(entry);
    }
  }

  const recommended = candidates
    .filter((c) => RECOMMENDED_STANDARD.includes(c.apiName))
    .sort((a, b) => RECOMMENDED_STANDARD.indexOf(a.apiName) - RECOMMENDED_STANDARD.indexOf(b.apiName));

  return {
    candidates,
    recommended,
    linkedIn,
    zoomInfo: { present: zoomInfoFields.length > 0, fields: zoomInfoFields },
    statusPicklists
  };
}

/**
 * Given metadata listings keyed by type, report which of the package components
 * already exist in the org (potential collisions to reuse or overwrite).
 */
export function detectCollisions(listsByType) {
  const wanted = {
    CustomObject: ['Contact_Enrichment_Suggestion__c'],
    Flow: ['Generate_Contact_Enrichment_Suggestions', 'Contact_Enrichment_Auto_Capture_LinkedIn_Departure'],
    GenAiPromptTemplate: ['Contact_Enrichment_Analysis'],
    LightningComponentBundle: ['contactEnrichmentWidget'],
    ApexClass: ['ContactEnrichmentController', 'ContactEnrichmentRetentionJob'],
    PermissionSet: ['Contact_Enrichment_Rep', 'Contact_Enrichment_Admin']
  };

  const collisions = [];
  for (const [type, names] of Object.entries(wanted)) {
    const present = new Set((listsByType[type] || []).map((m) => m.fullName));
    for (const name of names) {
      if (present.has(name)) collisions.push({ type, name });
    }
  }
  return collisions;
}
