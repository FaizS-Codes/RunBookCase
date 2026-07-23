// GET /api/tenders — proxies the Walmart Freight Tender API so the bearer
// token stays server-side and the browser never deals with CORS.

const WALMART_API = 'https://wmt-freight-portal.vercel.app/api/sap/loads';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed — use GET' });
  }

  const email = process.env.CANDIDATE_EMAIL;
  if (!email) {
    return res.status(500).json({ error: 'CANDIDATE_EMAIL environment variable is not set on the server' });
  }

  let upstream;
  try {
    upstream = await fetch(WALMART_API, {
      headers: { Authorization: `Bearer ${email}` },
    });
  } catch (err) {
    return res.status(502).json({ error: `Could not reach the Walmart Freight Tender API: ${err.message}` });
  }

  if (upstream.status === 401) {
    return res.status(502).json({ error: 'Walmart portal rejected the credentials (401). Check CANDIDATE_EMAIL.' });
  }
  if (upstream.status === 429) {
    const retryAfter = upstream.headers.get('retry-after') ?? 'a few';
    return res.status(429).json({ error: `Walmart portal rate limit hit. Retry in ${retryAfter} seconds.` });
  }
  if (!upstream.ok) {
    return res.status(502).json({ error: `Walmart portal returned an unexpected ${upstream.status}` });
  }

  const data = await upstream.json();
  return res.status(200).json(data);
}
