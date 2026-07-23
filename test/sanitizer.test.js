import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWeight, convertDate, mapEquipment, sanitizeTender, sanitizeAll } from '../lib/sanitizer.js';

const baseTender = {
  load_no: 'LD-20841',
  frt_ord_no: '4500219873',
  shipper_nm: 'NESTLE USA INC',
  orig_city: 'Anderson',
  orig_st: 'IN',
  dest_city: 'Bentonville',
  dest_st: 'AR',
  shp_dt: '07152026',
  del_dt: '07172026',
  wgt: '41,860 lbs',
  mode: 'AMBIENT',
};

test('parseWeight strips commas and lbs in any case', () => {
  assert.equal(parseWeight('41,860 lbs'), 41860);
  assert.equal(parseWeight('36,140 LBS'), 36140);
  assert.equal(parseWeight('  12,000 Lbs '), 12000);
  assert.equal(parseWeight('45000'), 45000);
  assert.equal(parseWeight(null), null);
  assert.equal(parseWeight('heavy'), null);
  assert.equal(parseWeight(''), null);
});

test('convertDate reorders MMDDYYYY to DDMMYYYY and rejects garbage', () => {
  assert.equal(convertDate('07152026'), '15072026');
  assert.equal(convertDate(' 12312026 '), '31122026');
  assert.equal(convertDate('13152026'), null); // month 13
  assert.equal(convertDate('2026-07-15'), null);
  assert.equal(convertDate(''), null);
});

test('mapEquipment maps modes case/whitespace-insensitively', () => {
  assert.equal(mapEquipment('AMBIENT'), "Dry Van 53'");
  assert.equal(mapEquipment('  freezer '), "Reefer 53'");
  assert.equal(mapEquipment('Refrigerated'), "Reefer 53'");
  assert.equal(mapEquipment('FRESH'), null);
  assert.equal(mapEquipment(''), null);
});

test('clean ambient tender sanitizes fully', () => {
  const result = sanitizeTender(baseTender);
  assert.equal(result.ok, true);
  assert.deepEqual(result.load, {
    load_number: 'LD-20841',
    bol_number: '4500219873',
    shipper_name: 'NESTLE USA INC',
    origin_city: 'Anderson',
    origin_state: 'IN',
    destination_city: 'Bentonville',
    destination_state: 'AR',
    ship_date: '15072026',
    delivery_date: '17072026',
    weight: 41860,
    equipment_type: "Dry Van 53'",
  });
});

test('padded whitespace and uppercase LBS are cleaned (real portal data)', () => {
  const result = sanitizeTender({
    ...baseTender,
    frt_ord_no: '  4540899367 ',
    shipper_nm: ' SCHREIBER FOODS INC  ',
    wgt: '36,140 LBS',
    mode: '  FREEZER ',
  });
  assert.equal(result.ok, true);
  assert.equal(result.load.bol_number, '4540899367');
  assert.equal(result.load.shipper_name, 'SCHREIBER FOODS INC');
  assert.equal(result.load.weight, 36140);
  assert.equal(result.load.equipment_type, "Reefer 53'");
});

test('overweight at exactly 45,000 lbs is flagged, not pushed', () => {
  const result = sanitizeTender({ ...baseTender, wgt: '45,000 lbs' });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.rule === 'overweight'));
});

test('44,999 lbs is NOT overweight', () => {
  const result = sanitizeTender({ ...baseTender, wgt: '44,999 lbs' });
  assert.equal(result.ok, true);
});

test('FRESH mode is flagged as ambiguous', () => {
  const result = sanitizeTender({ ...baseTender, mode: 'FRESH' });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.rule === 'ambiguous_mode'));
});

test('null weight is flagged as missing', () => {
  const result = sanitizeTender({ ...baseTender, wgt: null });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.rule === 'missing_weight'));
});

test('multiple problems are all reported', () => {
  const result = sanitizeTender({ ...baseTender, wgt: '48,000 lbs', mode: 'FRESH', shp_dt: 'soon' });
  assert.equal(result.ok, false);
  const rules = result.reasons.map((r) => r.rule).sort();
  assert.deepEqual(rules, ['ambiguous_mode', 'invalid_field', 'overweight']);
});

test('sanitizeAll splits valid and flagged', () => {
  const { valid, flagged } = sanitizeAll([baseTender, { ...baseTender, load_no: 'LD-2', mode: 'FRESH' }]);
  assert.equal(valid.length, 1);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].load_number, 'LD-2');
});
