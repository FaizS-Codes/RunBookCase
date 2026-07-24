// GET /api/rules — serves the SOP rule definitions to the UI rules panel so
// the page always shows exactly the logic the sanitizer applies.

import { MAPPING_RULES, FLAG_RULES, OVERWEIGHT_LBS, EQUIPMENT_MAP } from '../lib/sanitizer.js';

export default function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed — use GET' });
  }
  return res.status(200).json({
    mapping: MAPPING_RULES,
    flags: FLAG_RULES,
    overweightLbs: OVERWEIGHT_LBS,
    equipmentMap: EQUIPMENT_MAP,
    identity: process.env.CANDIDATE_EMAIL ?? null,
  });
}
