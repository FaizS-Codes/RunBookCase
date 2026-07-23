// POST /api/sanitize-push — sanitizes Walmart tenders per the SOP and pushes
// the valid ones to the SHV SOR. Body: { loads: [...] } (the tenders the user
// fetched); if omitted, fetches fresh tenders from the Walmart portal.
//
// Response: {
//   accepted: [{ load_number, before, after }],
//   rejected: [{ load_number, errors, after }],   // per-load SOR 422 errors
//   flagged:  [{ load_number, reasons, raw }],    // held per SOP, never pushed
//   sorMessage: string | null
// }

import { sanitizeAll } from '../lib/sanitizer.js';

const WALMART_API = 'https://wmt-freight-portal.vercel.app/api/sap/loads';
const SOR_API = 'https://shv-logistics-tms.vercel.app/api/sor/loads';
const SOR_BATCH_LIMIT = 50;
const MAX_RETRY_AFTER_SECONDS = 20;

async function postBatch(loads, email) {
  const doPost = () =>
    fetch(SOR_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${email}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ loads }),
    });

  let response = await doPost();
  if (response.status === 429) {
    const retryAfter = Math.min(parseInt(response.headers.get('retry-after') ?? '5', 10) || 5, MAX_RETRY_AFTER_SECONDS);
    await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
    response = await doPost(); // pushes are upserts, safe to retry once
  }
  return response;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed — use POST' });
  }

  const email = process.env.CANDIDATE_EMAIL;
  if (!email) {
    return res.status(500).json({ error: 'CANDIDATE_EMAIL environment variable is not set on the server' });
  }

  // Use the tenders the frontend fetched, or pull fresh ones.
  let tenders = Array.isArray(req.body?.loads) ? req.body.loads : null;
  if (!tenders) {
    try {
      const upstream = await fetch(WALMART_API, { headers: { Authorization: `Bearer ${email}` } });
      if (!upstream.ok) {
        return res.status(502).json({ error: `Could not fetch tenders from the Walmart portal (${upstream.status})` });
      }
      tenders = (await upstream.json()).loads ?? [];
    } catch (err) {
      return res.status(502).json({ error: `Could not reach the Walmart Freight Tender API: ${err.message}` });
    }
  }

  const { valid, flagged } = sanitizeAll(tenders);
  const flaggedOut = flagged.map(({ load_number, reasons, raw }) => ({ load_number, reasons, raw }));

  if (valid.length === 0) {
    return res.status(200).json({
      accepted: [],
      rejected: [],
      flagged: flaggedOut,
      sorMessage: tenders.length === 0 ? 'No tenders to process.' : 'No loads were eligible to push — all were flagged.',
    });
  }

  const byLoadNumber = new Map(valid.map((v) => [v.load.load_number, v]));
  const accepted = [];
  const rejected = [];
  let sorMessage = null;

  // Batch in chunks of 50 (SOR per-request limit).
  for (let i = 0; i < valid.length; i += SOR_BATCH_LIMIT) {
    const chunk = valid.slice(i, i + SOR_BATCH_LIMIT).map((v) => v.load);

    let response;
    try {
      response = await postBatch(chunk, email);
    } catch (err) {
      return res.status(502).json({ error: `Could not reach the SHV SOR API: ${err.message}` });
    }

    if (response.status === 401) {
      return res.status(502).json({ error: 'SHV SOR rejected the credentials (401). Check CANDIDATE_EMAIL.' });
    }
    if (response.status === 429) {
      return res.status(429).json({ error: 'SHV SOR rate/capacity limit hit even after retrying. Wait and push again — pushes are safe to retry.' });
    }

    let body;
    try {
      body = await response.json();
    } catch {
      return res.status(502).json({ error: `SHV SOR returned an unreadable ${response.status} response` });
    }

    if (response.status !== 200 && response.status !== 422) {
      return res.status(502).json({ error: `SHV SOR returned an unexpected ${response.status}: ${body?.message ?? ''}` });
    }

    sorMessage = body?.message ?? sorMessage;
    for (const loadNumber of body?.accepted ?? []) {
      const match = byLoadNumber.get(loadNumber);
      accepted.push({ load_number: loadNumber, before: match?.raw ?? null, after: match?.load ?? null });
    }
    for (const rejection of body?.rejected ?? []) {
      const match = byLoadNumber.get(rejection?.load_number);
      rejected.push({ load_number: rejection?.load_number, errors: rejection?.errors ?? [], after: match?.load ?? null });
    }
  }

  return res.status(200).json({ accepted, rejected, flagged: flaggedOut, sorMessage });
}
