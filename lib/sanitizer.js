// Sanitization + validation logic for Walmart freight tenders -> SHV SOR loads.
// This module is the single source of truth for the SOP rules: the API routes
// run these functions, and /api/rules serves MAPPING_RULES / FLAG_RULES to the UI.

export const OVERWEIGHT_LBS = 45000;

// Walmart "Mode" -> SOR equipment_type (SOP Step 14)
export const EQUIPMENT_MAP = {
  AMBIENT: "Dry Van 53'",
  REFRIGERATED: "Reefer 53'",
  FREEZER: "Reefer 53'",
};

export const MAX_STRING_LEN = 200;

// Human-readable mapping rules, rendered in the UI rules panel.
export const MAPPING_RULES = [
  { sor: 'Load Number', source: 'Load No. (load_no)', transform: 'No transformation required. Copy as is.' },
  { sor: 'BOL Number', source: 'Freight Order No. (frt_ord_no)', transform: 'No transformation required. Copy as is.' },
  { sor: 'Shipper Name', source: 'Shipper (shipper_nm)', transform: 'No transformation required. Copy as is.' },
  { sor: 'Origin City', source: 'Origin City (orig_city)', transform: 'No transformation required. Copy as is.' },
  { sor: 'Origin State', source: 'Origin State (orig_st)', transform: 'No transformation required. Copy as is.' },
  { sor: 'Destination City', source: 'Destination City (dest_city)', transform: 'No transformation required. Copy as is.' },
  { sor: 'Destination State', source: 'Destination State (dest_st)', transform: 'No transformation required. Copy as is.' },
  { sor: 'Expected Ship Date', source: 'Ship Date (shp_dt)', transform: 'Transform from MMDDYYYY → DDMMYYYY' },
  { sor: 'Expected Delivery Date', source: 'Delivery Date (del_dt)', transform: 'Transform from MMDDYYYY → DDMMYYYY' },
  { sor: 'Total Weight (lbs)', source: 'Gross Weight (wgt)', transform: 'Remove commas and the "lbs" unit label; send as a plain whole number (e.g. "41,860 lbs" → 41860).' },
  { sor: 'Equipment Type', source: 'Mode (mode)', transform: `AMBIENT → Dry Van 53'\nREFRIGERATED or FREEZER → Reefer 53'` },
];

// Escalation / hold rules, rendered in the UI rules panel. Loads matching any
// of these are NEVER pushed to the SOR — they are flagged for follow-up.
export const FLAG_RULES = [
  {
    id: 'overweight',
    title: `Overweight load (≥ ${OVERWEIGHT_LBS.toLocaleString('en-US')} lbs)`,
    trigger: `Tender weight is at or above ${OVERWEIGHT_LBS.toLocaleString('en-US')} lbs`,
    action: 'Do not build the load. Initiate the 3-step weight-correction process with Walmart, then re-run.',
    sopRef: 'Edge Case',
  },
  {
    id: 'ambiguous_mode',
    title: 'Ambiguous mode ("Fresh" or unrecognized)',
    trigger: 'Mode is not a clear AMBIENT / REFRIGERATED / FREEZER value',
    action: 'Do not select equipment. Contact Walmart for the exact temperature range before building the load.',
    sopRef: 'Edge Case',
  },
  {
    id: 'missing_weight',
    title: 'Missing or unreadable weight',
    trigger: 'Tender weight is blank or cannot be parsed to a number',
    action: 'Do not build the load. All SOR fields are required, so confirm the true weight with Walmart first.',
    sopRef: 'Final Checks',
  },
  {
    id: 'invalid_field',
    title: 'Missing or malformed required field',
    trigger: 'Any other required field is blank, malformed, or over 200 characters (e.g. an unreadable date)',
    action: 'Do not build the load. Confirm the correct value with Walmart before pushing.',
    sopRef: 'Final Checks',
  },
];

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

// "41,860 lbs" / "36,140 LBS" / "41860" -> 41860; null/garbage -> null
export function parseWeight(raw) {
  if (raw == null) return null;
  const cleaned = trimmed(raw).replace(/lbs\.?/gi, '').replace(/,/g, '').trim();
  if (!/^\d+$/.test(cleaned)) return null;
  return parseInt(cleaned, 10);
}

// MMDDYYYY -> DDMMYYYY, with plausibility checks. Returns null if unusable.
export function convertDate(raw) {
  const s = trimmed(raw);
  if (!/^\d{8}$/.test(s)) return null;
  const mm = parseInt(s.slice(0, 2), 10);
  const dd = parseInt(s.slice(2, 4), 10);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return s.slice(2, 4) + s.slice(0, 2) + s.slice(4);
}

export function mapEquipment(rawMode) {
  return EQUIPMENT_MAP[trimmed(rawMode).toUpperCase()] ?? null;
}

/**
 * Sanitize one Walmart tender into an SOR load.
 * Returns { ok: true, load } or { ok: false, reasons: [{rule, detail}] }.
 * Collects every applicable flag reason, not just the first.
 */
export function sanitizeTender(tender) {
  const reasons = [];
  const load = {};

  const requiredStrings = [
    ['load_number', 'load_no'],
    ['bol_number', 'frt_ord_no'],
    ['shipper_name', 'shipper_nm'],
    ['origin_city', 'orig_city'],
    ['origin_state', 'orig_st'],
    ['destination_city', 'dest_city'],
    ['destination_state', 'dest_st'],
  ];
  for (const [sorField, srcField] of requiredStrings) {
    const value = trimmed(tender?.[srcField]);
    if (!value) {
      reasons.push({ rule: 'invalid_field', detail: `${sorField} is missing (Walmart field "${srcField}" is blank)` });
    } else if (value.length > MAX_STRING_LEN) {
      reasons.push({ rule: 'invalid_field', detail: `${sorField} exceeds ${MAX_STRING_LEN} characters` });
    }
    load[sorField] = value;
  }

  if (load.load_number && !/^LD-\d+$/.test(load.load_number)) {
    reasons.push({ rule: 'invalid_field', detail: `load_number "${load.load_number}" does not match the LD-<digits> format` });
  }

  for (const [sorField, srcField, label] of [
    ['ship_date', 'shp_dt', 'ship date'],
    ['delivery_date', 'del_dt', 'delivery date'],
  ]) {
    const converted = convertDate(tender?.[srcField]);
    if (!converted) {
      reasons.push({ rule: 'invalid_field', detail: `${label} "${tender?.[srcField] ?? ''}" is not a readable MMDDYYYY date` });
    }
    load[sorField] = converted ?? '';
  }

  const weight = parseWeight(tender?.wgt);
  if (weight == null) {
    reasons.push({ rule: 'missing_weight', detail: `weight "${tender?.wgt ?? '(blank)'}" is missing or unreadable` });
  } else {
    load.weight = weight;
    if (weight >= OVERWEIGHT_LBS) {
      reasons.push({
        rule: 'overweight',
        detail: `weight ${weight.toLocaleString('en-US')} lbs is at/above the ${OVERWEIGHT_LBS.toLocaleString('en-US')} lbs limit. Start Walmart's weight-correction process`,
      });
    }
  }

  const equipment = mapEquipment(tender?.mode);
  if (!equipment) {
    const mode = trimmed(tender?.mode).toUpperCase();
    reasons.push({
      rule: 'ambiguous_mode',
      detail: mode === 'FRESH'
        ? 'mode is "Fresh". Contact Walmart for the exact temperature range before selecting equipment'
        : `mode "${tender?.mode ?? '(blank)'}" is not a recognized Ambient/Refrigerated/Freezer value. Contact Walmart before selecting equipment`,
    });
  } else {
    load.equipment_type = equipment;
  }

  return reasons.length ? { ok: false, reasons } : { ok: true, load };
}

/**
 * Sanitize a batch. Returns:
 *   valid:   [{ raw, load }]                — ready to push
 *   flagged: [{ raw, load_number, reasons }] — held per SOP, never pushed
 */
export function sanitizeAll(tenders) {
  const valid = [];
  const flagged = [];
  for (const raw of tenders ?? []) {
    const result = sanitizeTender(raw);
    if (result.ok) valid.push({ raw, load: result.load });
    else flagged.push({ raw, load_number: trimmed(raw?.load_no) || '(unknown)', reasons: result.reasons });
  }
  return { valid, flagged };
}
