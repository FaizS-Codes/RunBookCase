# RunBookCase — Walmart → SHV TMS Load Bridge

Automates the daily runbook by which SHV Logistics builds Walmart freight tenders into its TMS. The app pulls open tenders from the Walmart Freight Tender API, sanitizes them per the SOP rules, and pushes ready loads into the SHV SOR Integration API. Exception loads (overweight, ambiguous mode, missing data) are **held and flagged for follow-up — never pushed**, exactly as the runbook requires.

## How it works

Two buttons:

1. **Fetch Loads** — `GET /api/tenders` proxies the Walmart portal and shows the raw open tenders.
2. **Sanitize & Push** — `POST /api/sanitize-push` runs every tender through the sanitizer, pushes eligible loads to the SHV SOR in one batch, and shows a full reconciliation: ✅ accepted, ❌ rejected by the SOR (with per-load errors), ⚠️ flagged per SOP.

The UI also renders a **rules panel** (mapping + escalation rules) served from the same definitions the sanitizer executes, so the displayed rules can't drift from the code.

## SOP rules implemented ([lib/sanitizer.js](lib/sanitizer.js))

| Walmart field | SOR field | Transform |
|---|---|---|
| `load_no` | `load_number` | trim; must match `LD-<digits>` |
| `frt_ord_no` | `bol_number` | trim (Walmart's "Freight Order Number" is the BOL) |
| `shipper_nm` | `shipper_name` | trim |
| `orig_city` / `orig_st` | `origin_city` / `origin_state` | trim |
| `dest_city` / `dest_st` | `destination_city` / `destination_state` | trim |
| `shp_dt` / `del_dt` | `ship_date` / `delivery_date` | reorder MMDDYYYY → DDMMYYYY |
| `wgt` | `weight` | strip commas + "lbs" (any case), send as whole number |
| `mode` | `equipment_type` | AMBIENT → `Dry Van 53'` · REFRIGERATED / FREEZER → `Reefer 53'` |

Escalation (flagged, never pushed):

- **Overweight ≥ 45,000 lbs** — start Walmart's weight-correction process first (SOP Step 13).
- **Mode = "Fresh" or unrecognized** — get the exact temperature range from Walmart before selecting equipment (SOP Step 14).
- **Missing/unreadable weight or any malformed required field** — all SOR fields are required; confirm with Walmart first.

## Run locally

```bash
cp .env.example .env   # set CANDIDATE_EMAIL
npm run dev            # http://localhost:3456
npm test               # sanitizer unit tests
```

No dependencies — plain Node (18+) and vanilla HTML/JS.

## Deploy (Vercel)

Import the repo into Vercel (framework preset: **Other**) and set one environment variable:

- `CANDIDATE_EMAIL` — the email used as the bearer token for both APIs.

`public/` is served statically; `api/` becomes serverless functions. No build step.
