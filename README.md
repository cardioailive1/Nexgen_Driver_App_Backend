# Nexgen Driver App — Backend

Express + Socket.io + Prisma. Deploy this to Fly.io. Data lives in a Postgres
database (e.g. a Render Postgres instance), managed by Prisma.

## 1. Database — Render Postgres

1. In the Render dashboard: **New → PostgreSQL**. Pick a name/region and create it.
2. Once it's up, open the database and copy the **External Connection String**
   (not the internal one — Fly.io isn't on Render's private network, so this
   backend needs the external URL to reach it).
3. Paste it into `DATABASE_URL` below.

## 2. Local setup

```bash
cp .env.example .env
# edit .env: paste your Render Postgres External Connection String into DATABASE_URL

npm install
npx prisma migrate dev --name init   # creates the tables, using your real DATABASE_URL
npm start                             # http://localhost:3000
```

Confirm it's running: `http://localhost:3000/health` should return `{"ok":true}`.

## 3. Deploy to Fly.io

```bash
fly launch --no-deploy   # picks/creates your app name; fly.toml is already here
fly secrets set DATABASE_URL="<your Render external connection string>"
fly secrets set FRONTEND_ORIGIN="https://<your-frontend>.onrender.com"
fly deploy
```

`fly.toml` already has `release_command = "npx prisma migrate deploy"`, so
every deploy applies any pending migrations to the database automatically.

Confirm it's up: `https://<your-app>.fly.dev/health` should return `{"ok":true}`.

**`FRONTEND_ORIGIN`** controls CORS — it must exactly match the URL of the
frontend (from the companion `nexgen-driver-app-frontend.zip`) or the browser
will block requests. Comma-separate multiple origins if the driver and rider
apps end up on different URLs.

## 4. Driver accounts — email + password authentication

Drivers now have real accounts instead of a random ID stored on one device —
they can log in from any phone and keep their application/approval status.

```
JWT_SECRET="..."   # generate with: openssl rand -hex 32
```
```bash
fly secrets set JWT_SECRET="$(openssl rand -hex 32)"
```

**Endpoints:**
```
POST /api/auth/register          { name, email, password } -> { driverId, token, driver }
POST /api/auth/login             { email, password }        -> { driverId, token, driver }
GET  /api/auth/me                (Bearer token)              -> current driver + history
POST /api/auth/change-password   (Bearer token) { currentPassword, newPassword }
```

Every other `/api/driver/:id/...` endpoint now requires an `Authorization:
Bearer <token>` header, and checks that the token's driver matches the `:id`
in the URL — a real fix, not a formality: earlier versions of this backend
trusted whatever `:id` was in the URL, so anyone who saw or guessed a
driverId could read or edit that person's application. The socket protocol
changed the same way — `driver:join` now sends a `token` instead of a bare
`driverId`, and every other driver socket event uses the driverId attached
to that authenticated socket connection, not whatever a client claims in the
event payload.

**What's deliberately not here:** password reset via email. That needs an
email-sending service (SendGrid, Postmark, SES, etc.) that isn't configured
anywhere in this project. Without it, a driver who forgets their password has
no way back into their account — add a real reset flow before this handles
real drivers.

## 5. Payments — Stripe Connect

Get test-mode keys from your [Stripe dashboard](https://dashboard.stripe.com/apikeys).

```bash
fly secrets set STRIPE_SECRET_KEY="sk_test_..." STRIPE_WEBHOOK_SECRET="whsec_..."
```

(`STRIPE_WEBHOOK_SECRET` comes from https://dashboard.stripe.com/webhooks — optional but recommended.)

**How it works:**
- **Drivers** connect a Stripe Express account via a hosted onboarding link
  (`POST /api/driver/:id/stripe/onboard-link`) that collects bank details and
  identity info — this backend never sees or stores that data directly.
- **Riders** save a card client-side via Stripe Elements; the raw card number
  never reaches this backend.
- On trip completion, if both sides have finished Stripe setup, the backend
  creates a **destination charge** and splits the fare three ways:
  - **60%** transfers directly to the driver's connected account (`DRIVER_PCT`)
  - **20%** stays with Nexgen as platform revenue (`PLATFORM_PCT`)
  - **20%** is reserved for payment processing fees + insurance (`FEES_INSURANCE_PCT`)

  Stripe itself only supports a 2-way split per charge — the platform account
  vs. the driver's connected account — so the platform/fees-insurance
  distinction within that combined 40% is tracked in Nexgen's own database
  (`TripRecord.platformFee` / `TripRecord.insuranceFee`), not by Stripe. All
  three percentages are single constants at the top of `server.js` if you
  need to change the split.
- Driver `earnings` reflects their actual 60% take-home, not the full fare —
  this is computed the same way whether or not a real Stripe charge happens,
  so the numbers stay consistent even before a driver finishes Stripe setup.
- If either side hasn't set up payments, the trip still completes — the fare
  is recorded as unpaid (`paymentStatus: "skipped"`) rather than blocking the ride.

**What this does *not* handle** (real gaps):
- **3D Secure / SCA challenges** — the charge runs `off_session`; a card
  needing interactive authentication fails (`paymentStatus: "requires_action"`)
  rather than prompting the rider.
- **Refunds, disputes, partial charges** — none of that exists here.
- **Webhook reliability** — no retry/reconciliation if a webhook is missed.

## 6. Driver applications — documents + Checkr background checks

Drivers can't go online until their application reaches `approved` —
enforced server-side in the `driver:online` socket handler, not just in the UI.

**Document storage (S3-compatible bucket):**
```
S3_BUCKET="nexgen-driver-documents"
S3_REGION="us-east-1"
S3_ACCESS_KEY_ID="..."
S3_SECRET_ACCESS_KEY="..."
S3_ENDPOINT=""   # only needed for Cloudflare R2 / Backblaze B2 / MinIO
```
```bash
fly secrets set S3_BUCKET="..." S3_REGION="..." S3_ACCESS_KEY_ID="..." S3_SECRET_ACCESS_KEY="..."
```
Uploads go straight from the driver's browser to this bucket via a presigned
URL — files never pass through this backend. Every document read (by the
driver or by admin) uses a short-lived presigned GET generated on demand;
nothing is ever public.

**Checkr (background checks):**
```
CHECKR_API_KEY="..."           # from the Checkr dashboard, sandbox mode while testing
CHECKR_WEBHOOK_SECRET="..."    # set a webhook in Checkr pointing at /api/checkr/webhook
```
```bash
fly secrets set CHECKR_API_KEY="..." CHECKR_WEBHOOK_SECRET="..."
```

**How the background check flow works:**
- On submission, this backend creates a Checkr candidate + invitation and
  gets back an `invitation_url`.
- The driver is sent to **Checkr's own hosted page** to finish the rest —
  including their SSN — and give FCRA consent. **This backend and this
  database never see the SSN or handle the consent flow themselves.** That's
  a deliberate design choice to limit liability, not an oversight.
- Checkr's webhook updates `checkrStatus` as the report progresses. A
  completed report (`clear`, `consider`, etc.) moves the application from
  `submitted` to `under_review` — it does **not** auto-approve. Insurance and
  vehicle documents still need a human to look at them.

**Legal note (read this before using this with real applicants):** background
checks in the US trigger the Fair Credit Reporting Act (FCRA) — specific
required disclosures, written consent, and "adverse action" procedures if you
reject someone based on the report. Checkr's hosted flow handles the
disclosure/consent step, but the adverse-action process on your side (if you
reject someone partly because of the report) is still your responsibility.
This is not legal advice — get real legal review before this handles real
applicants.

## 7. Admin accounts & review

Real admin accounts (email + password, JWT with `role: 'admin'`) — not the
earlier shared-token scheme. A driver's login token can never pass as an
admin token, and vice versa; they're checked by completely separate
middleware (`requireAuth`/`requireSelf` vs. `requireAdminAuth` in `auth.js`).

**Creating the first admin** requires a server-side setup key, since
`/api/admin/auth/register` has no other access control:
```bash
fly secrets set ADMIN_SETUP_KEY="$(openssl rand -hex 32)"
```
```
POST /api/admin/auth/register   { name, email, password, setupKey }
POST /api/admin/auth/login      { email, password }
GET  /api/admin/auth/me         (Bearer token)
```
Once you have at least one admin account, you can leave `ADMIN_SETUP_KEY` set
(to create more admins later) or unset it — existing admins can still log in
either way.

**Reviewing applications:**
```
GET  /api/admin/applications?status=submitted
GET  /api/admin/applications/:id
POST /api/admin/applications/:id/decision   { decision: "approved"|"rejected", notes }
```

Approving or rejecting now pushes the decision to the driver **immediately**
over their existing socket connection (`application:decision` event) instead
of them only finding out the next time the app happens to re-check.

**Deactivating / reactivating a driver:**
```
POST /api/admin/drivers/:id/deactivate
POST /api/admin/drivers/:id/reactivate
```
Deactivating a driver takes effect immediately, not just on their next login:
it force-disconnects their live socket if they're currently connected, sends
them an `account:deactivated` event first so the app can show why, and blocks
`/api/auth/login` and the `driver:online` socket event going forward.

## 8. Fare calculation — mileage + real gas prices

Every fare is `base + (distance \u00d7 per-km rate) + (duration \u00d7 per-min rate)`,
same shape as before — but the per-km rate now has a real fuel component
instead of being one flat number decided once and never revisited.

```
base fare              $2.50 (BASE_FARE)
non-fuel per km        $0.75 (NON_FUEL_PER_KM — vehicle wear, insurance amortization, margin)
fuel per km            (current gas price \u00f7 assumed MPG) \u00f7 1.60934
per minute             $0.22 (PER_MIN)
```

**Gas price source:** the U.S. Energy Information Administration's free
public API (weekly national average for regular gasoline), cached for 24
hours. Set `EIA_API_KEY` (free registration at
https://www.eia.gov/opendata/register.php) to use it; without a key, or if
EIA is unreachable, every fare falls back to `FALLBACK_GAS_PRICE_PER_GALLON`.

**Two real limitations, not glossed over:**
- EIA's number is a **weekly national average**, not real-time and not
  local to wherever a ride actually happens. Gas prices vary more by
  state/region than they change week to week — this is a reasonable proxy,
  not a precise local price.
- `ASSUMED_MPG` (25 by default) is one number for every vehicle. A hybrid and
  a truck get charged the same fuel component per km, because there's no
  per-driver actual-vehicle fuel economy tracked anywhere in this app.

**A real bug this fixes:** the upfront fare estimate shown to riders before
requesting, and to drivers on the incoming request card, used to be a
completely different, separately-made-up formula (`$2.50 + miles \u00d7 $1.50`)
from what actually got charged at trip completion. They could — and did —
disagree. Both now call `GET /api/fare/rates` and compute the estimate with
the exact same numbers that will be charged, so the estimate and the final
bill can't drift apart the way they used to.

Every `TripRecord` now stores the `gasPricePerGallon` and `fuelCostPerKm`
actually used, so a rider or driver questioning a fare later has a real
number to point to, not just "that's what the app said."

## Project structure

```
backend/
├── server.js          # Express + Socket.io — matching, trip lifecycle, Stripe, applications
├── auth.js               # Password hashing, JWT issuing/verification, auth middleware
├── documents.js         # S3 presigned upload/download helpers
├── checkr.js             # Checkr candidate + invitation API client
├── fuelPricing.js         # Real gas price lookup (EIA) for fare calculation
├── prisma/schema.prisma
├── Dockerfile
├── fly.toml
├── .env.example
└── package.json
```

## Pairs with

The frontend (driver app + rider app) is deployed separately to Render as a
static site — see `nexgen-driver-app-frontend.zip`. After deploying it, come
back and update `FRONTEND_ORIGIN` above to its real URL.
