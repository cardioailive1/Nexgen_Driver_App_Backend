const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { PrismaClient } = require('@prisma/client');
const Stripe = require('stripe');
const documents = require('./documents');
const checkr = require('./checkr');
const auth = require('./auth');
const fuelPricing = require('./fuelPricing');

const prisma = new PrismaClient();
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const DRIVER_PCT = 0.60;          // driver's take-home
const PLATFORM_PCT = 0.20;        // Nexgen's revenue
const FEES_INSURANCE_PCT = 0.20;  // reserved for payment processing + insurance
// Stripe only supports a 2-way split per charge (platform account vs. the
// driver's connected account) — see the comment in trip:complete below for
// how the platform/fees-insurance distinction is tracked internally.

// ---------------------------------------------------------------------------
// Fare calculation. Every fare has three parts:
//   base            — flat pickup fee
//   distance charge — per-km rate, split into a non-fuel component (vehicle
//                     wear, insurance amortization, margin) and a fuel
//                     component computed from the CURRENT gas price
//   time charge     — per-minute rate, unrelated to fuel
//
// The "correctly" in "charge riders correctly based on mileage and gas
// prices" is doing real work here: this refactor makes the fuel cost a real,
// currently-priced number instead of a number baked into a flat per-km rate
// years ago and never revisited. It's still an average, not a measurement of
// this specific vehicle's actual fuel use — see ASSUMED_MPG below.
// ---------------------------------------------------------------------------
const BASE_FARE = 2.5;
const NON_FUEL_PER_KM = 0.75;   // vehicle wear, insurance amortization, margin — not fuel
const PER_MIN = 0.22;           // driver time compensation — not fuel, not distance
const ASSUMED_MPG = 25;         // average vehicle fuel economy assumption — see README for the real caveat here
const KM_PER_MILE = 1.60934;

/** The one place fares are computed — used for both the final charge at
 * trip completion AND the upfront estimate shown to riders/drivers, so the
 * two can never drift apart the way they used to (the old estimate used a
 * different, made-up formula from the one that actually got charged). */
async function computeFare(distanceKm, durationMin) {
  const { pricePerGallon, source } = await fuelPricing.getGasPrice();
  const fuelCostPerMile = pricePerGallon / ASSUMED_MPG;
  const fuelCostPerKm = fuelCostPerMile / KM_PER_MILE;
  const perKmEffective = NON_FUEL_PER_KM + fuelCostPerKm;

  const distFare = distanceKm * perKmEffective;
  const timeFare = durationMin * PER_MIN;
  const total = +(BASE_FARE + distFare + timeFare).toFixed(2);

  return {
    total,
    base: BASE_FARE,
    distFare: +distFare.toFixed(2),
    timeFare: +timeFare.toFixed(2),
    gasPricePerGallon: pricePerGallon,
    gasPriceSource: source,
    fuelCostPerKm: +fuelCostPerKm.toFixed(4),
    nonFuelPerKm: NON_FUEL_PER_KM,
    perMin: PER_MIN,
  };
}

const app = express();
const server = http.createServer(app);

// ---------------------------------------------------------------------------
// CORS: the frontend is deployed separately (e.g. Render static site), so
// this backend needs to explicitly allow that origin. Set FRONTEND_ORIGIN to
// a comma-separated list of allowed origins in production.
// Example: FRONTEND_ORIGIN=https://nexgen-driver.onrender.com,https://nexgen-rider.onrender.com
// ---------------------------------------------------------------------------
const allowedOrigins = (process.env.FRONTEND_ORIGIN || '*')
  .split(',')
  .map((s) => s.trim());

const corsOptions = {
  origin: allowedOrigins.includes('*') ? true : allowedOrigins,
};

app.use(cors(corsOptions));

// Stripe webhooks need the raw request body to verify the signature, so this
// route is registered with express.raw() BEFORE the global express.json()
// below (Express matches routes in the order they're declared).
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(400).send('Webhooks not configured');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
  }

  if (event.type === 'payment_intent.succeeded' || event.type === 'payment_intent.payment_failed') {
    const pi = event.data.object;
    const status = event.type === 'payment_intent.succeeded' ? 'succeeded' : 'failed';
    await prisma.tripRecord.updateMany({ where: { paymentIntentId: pi.id }, data: { paymentStatus: status } }).catch(() => {});
  }
  res.json({ received: true });
});

// Checkr webhooks — same raw-body requirement as Stripe above, for signature
// verification (Checkr signs with HMAC-SHA256 using CHECKR_WEBHOOK_SECRET).
app.post('/api/checkr/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!process.env.CHECKR_WEBHOOK_SECRET) return res.status(400).send('Checkr webhooks not configured');

  const crypto = require('crypto');
  const signature = req.headers['x-checkr-signature'];
  const expected = crypto.createHmac('sha256', process.env.CHECKR_WEBHOOK_SECRET).update(req.body).digest('hex');
  if (signature !== expected) return res.status(400).send('Invalid signature');

  let event;
  try {
    event = JSON.parse(req.body.toString());
  } catch {
    return res.status(400).send('Invalid payload');
  }

  const candidateId = event.data?.object?.candidate_id || event.data?.object?.id;
  const reportStatus = event.data?.object?.status; // e.g. 'clear', 'consider', 'suspended'
  const reportId = event.type?.startsWith('report.') ? event.data?.object?.id : undefined;

  if (candidateId) {
    const application = await prisma.driverApplication.findFirst({ where: { checkrCandidateId: candidateId } });
    if (application) {
      const data = { checkrStatus: reportStatus || application.checkrStatus };
      if (reportId) data.checkrReportId = reportId;
      // Checkr finishing the report moves the application into manual
      // review — a clear/consider result is not itself an approval, since
      // insurance and vehicle documents still need a human to check them.
      if (application.status === 'submitted' && reportStatus) data.status = 'under_review';
      await prisma.driverApplication.update({ where: { id: application.id }, data }).catch(() => {});
    }
  }
  res.json({ received: true });
});

app.use(express.json());

const io = new Server(server, { cors: corsOptions });

app.get('/health', (req, res) => res.json({ ok: true, stripe: !!stripe }));

// Public — lets both the driver and rider apps compute an upfront estimate
// using the exact same rates that will actually be charged, instead of a
// separately-maintained guess that can silently drift from real billing.
app.get('/api/fare/rates', async (req, res) => {
  const { pricePerGallon, source, fetchedAt } = await fuelPricing.getGasPrice();
  const fuelCostPerKm = pricePerGallon / ASSUMED_MPG / KM_PER_MILE;
  res.json({
    base: BASE_FARE,
    nonFuelPerKm: NON_FUEL_PER_KM,
    perMin: PER_MIN,
    fuelCostPerKm: +fuelCostPerKm.toFixed(4),
    perKmEffective: +(NON_FUEL_PER_KM + fuelCostPerKm).toFixed(4),
    gasPricePerGallon: pricePerGallon,
    gasPriceSource: source, // 'eia' or 'fallback' — see fuelPricing.js
    assumedMpg: ASSUMED_MPG,
    gasPriceFetchedAt: fetchedAt,
  });
});

// ---------------------------------------------------------------------------
// In-memory socket routing only — everything durable (earnings, trip
// history, ride state) lives in Postgres via Prisma. Losing this map on
// restart just means active sockets have to reconnect and re-join.
// ---------------------------------------------------------------------------
const driverSockets = {}; // driverId -> socket.id
const riderSockets = {};  // riderId  -> socket.id

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---------------------------------------------------------------------------
// Driver matching. Two dispatch modes, chosen automatically:
//
//   - "direct": only one available driver exists — dispatch straight to
//     them, no need to spend an OSRM call comparing candidates.
//   - "matched": 2+ available drivers — take the nearest few by fast
//     straight-line distance (cheap, no network call), then use real road
//     distance/time from OSRM to pick the actual best one among just those
//     candidates. Straight-line "nearest" and road-distance "nearest" are
//     not always the same driver (a river, a highway split, one-way
//     streets), so this catches cases the old straight-line-only matching
//     would get wrong.
// ---------------------------------------------------------------------------
const MATCH_CANDIDATE_COUNT = 3; // how many nearby drivers to road-compare

async function fetchRoadDistance(lat1, lng1, lat2, lng2) {
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${lng1},${lat1};${lng2},${lat2}?overview=false`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.code === 'Ok' && data.routes && data.routes[0]) {
      return { distanceKm: data.routes[0].distance / 1000, durationMin: data.routes[0].duration / 60 };
    }
  } catch (err) {
    // OSRM unreachable or rate-limited — caller falls back to straight-line.
  }
  return null;
}

async function matchDriver(lat, lng, excludeIds = []) {
  const candidates = await prisma.driver.findMany({
    where: { online: true, activeRideId: null, lat: { not: null }, id: { notIn: excludeIds } },
  });
  if (candidates.length === 0) return { driver: null, mode: 'none' };

  const byStraightLine = candidates
    .map((d) => ({ driver: d, straightLineKm: haversineKm(lat, lng, d.lat, d.lng) }))
    .sort((a, b) => a.straightLineKm - b.straightLineKm);

  if (byStraightLine.length === 1) {
    const only = byStraightLine[0];
    return { driver: only.driver, mode: 'direct', distanceKm: only.straightLineKm, durationMin: null };
  }

  const topCandidates = byStraightLine.slice(0, MATCH_CANDIDATE_COUNT);
  const withRoadDistance = await Promise.all(
    topCandidates.map(async (c) => {
      const road = await fetchRoadDistance(lat, lng, c.driver.lat, c.driver.lng);
      return {
        driver: c.driver,
        distanceKm: road ? road.distanceKm : c.straightLineKm,
        durationMin: road ? road.durationMin : null,
        usedFallback: !road,
      };
    })
  );

  // Rank by drive time where we actually have it from OSRM; fall back to
  // distance (as a rough proxy) only for candidates OSRM couldn't reach.
  withRoadDistance.sort((a, b) => {
    const aVal = a.durationMin != null ? a.durationMin : a.distanceKm * 2.2;
    const bVal = b.durationMin != null ? b.durationMin : b.distanceKm * 2.2;
    return aVal - bVal;
  });

  const best = withRoadDistance[0];
  return { driver: best.driver, mode: 'matched', distanceKm: best.distanceKm, durationMin: best.durationMin };
}

// ---------------------------------------------------------------------------
// Rewards. Trip-completion points now follow an explicit schedule (points
// for the +5 rating bonus and +2 tip bonus are unchanged from before):
//
//   1 point  — completing a trip, normally
//   3 points — completing a trip during a bonus window:
//     - Every night, 9:00 PM – 2:00 AM ET (this is your "Mon-Fri 9pm-2am"
//       plus "Sat-Sun 9pm-2am" combined — together those cover all seven
//       nights, so it simplifies to "every night")
//     - Saturday & Sunday, 11:00 AM – 3:00 PM ET
//
// ASSUMPTION: the weekend night window was given as "9:00 pm-2:00pm", which
// can't be right (an end time can't be earlier in the clock than a 17-hour
// span implies) — I've treated it as "2:00 AM" to match the weekday
// pattern. Flag me if you meant something else.
//
// All times are evaluated in US Eastern time (America/New_York, which
// correctly auto-adjusts between EST/EDT — "EST" is normally used loosely
// to mean Eastern time year-round). If the runtime's ICU data is somehow
// missing (a stripped-down Node build) and the Eastern-time conversion
// throws, this falls back to the server's own local clock rather than
// crashing — that's the "default to local time zone" fallback.
//
// Tiers are derived from lifetime points, not stored separately, so there's
// no separate "current tier" column to drift out of sync.
// ---------------------------------------------------------------------------
function isBonusWindowET(date = new Date()) {
  let weekday, hour, minute;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    }).formatToParts(date);
    const get = (type) => parts.find((p) => p.type === type)?.value;
    weekday = get('weekday');
    hour = Number(get('hour')) % 24; // Intl can render midnight as "24"
    minute = Number(get('minute'));
  } catch (err) {
    // Fallback: server's own local time zone instead of Eastern.
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    weekday = days[date.getDay()];
    hour = date.getHours();
    minute = date.getMinutes();
  }

  const minutesOfDay = hour * 60 + minute;
  const nightWindow = minutesOfDay >= 21 * 60 || minutesOfDay < 2 * 60; // 9:00 PM – 2:00 AM, every day
  const weekendMidday = (weekday === 'Sat' || weekday === 'Sun') && minutesOfDay >= 11 * 60 && minutesOfDay < 15 * 60;

  return nightWindow || weekendMidday;
}

function pointsForTripCompletion(date = new Date()) {
  return isBonusWindowET(date) ? 3 : 1;
}

const REWARD_TIERS = [
  { name: 'Silver', threshold: 200 },
  { name: 'Gold', threshold: 400 },
  { name: 'Premium', threshold: 600 },
  { name: 'Diamond', threshold: 1000 },
];

function tierForPoints(points) {
  let current = null;
  for (const t of REWARD_TIERS) {
    if (points >= t.threshold) current = t;
  }
  return current;
}

function nextTierForPoints(points) {
  return REWARD_TIERS.find((t) => points < t.threshold) || null;
}

/** Increments a driver's reward points and pushes a live 'reward:tierUp'
 * event if that increment crosses into a new tier. */
async function awardPoints(driverId, amount) {
  const before = await prisma.driver.findUnique({ where: { id: driverId }, select: { rewardPoints: true } });
  if (!before) return;
  const beforeTier = tierForPoints(before.rewardPoints);

  const updated = await prisma.driver.update({ where: { id: driverId }, data: { rewardPoints: { increment: amount } } });
  const afterTier = tierForPoints(updated.rewardPoints);

  if (afterTier && afterTier.name !== (beforeTier && beforeTier.name) && driverSockets[driverId]) {
    io.to(driverSockets[driverId]).emit('reward:tierUp', { tier: afterTier.name, points: updated.rewardPoints });
  }
}

function toRideDTO(ride, riderName) {
  return {
    rideId: ride.id,
    requestId: ride.id,
    riderId: ride.riderId,
    driverId: ride.driverId,
    pickup: { lat: ride.pickupLat, lng: ride.pickupLng },
    drop: { lat: ride.dropLat, lng: ride.dropLng },
    pickupLabel: ride.pickupLabel,
    dropLabel: ride.dropLabel,
    estDistanceKm: ride.estDistanceKm,
    rider: riderName,
    status: ride.status,
    dispatchMode: ride.dispatchMode || null,
  };
}

async function driverWithHistory(driverId) {
  const driver = await prisma.driver.findUnique({ where: { id: driverId } });
  if (!driver) return null;
  const history = await prisma.tripRecord.findMany({
    where: { driverId },
    orderBy: { createdAt: 'desc' },
    take: 6,
  });
  return {
    ...driver,
    history: history.map((h) => ({
      pickupLabel: h.pickupLabel, dropLabel: h.dropLabel, fare: h.fare, time: h.createdAt.getTime(),
      driverPayout: h.driverPayout, paymentStatus: h.paymentStatus,
    })),
  };
}

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Driver authentication — email + password, JWT sessions. This is what lets
// a driver switch devices and keep their approved status, instead of the
// old scheme where "identity" was just a random ID stored in that one
// device's local storage.
// ---------------------------------------------------------------------------
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email, and password are required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  const existing = await prisma.driver.findUnique({ where: { email: email.toLowerCase() } });
  if (existing) return res.status(409).json({ error: 'An account with this email already exists.' });

  const passwordHash = await auth.hashPassword(password);
  const driver = await prisma.driver.create({ data: { name, email: email.toLowerCase(), passwordHash } });
  const token = auth.issueToken(driver.id);
  res.json({ driverId: driver.id, token, driver: { id: driver.id, name: driver.name, email: driver.email } });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

  const driver = await prisma.driver.findUnique({ where: { email: email.toLowerCase() } });
  if (!driver || !(await auth.verifyPassword(password, driver.passwordHash))) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  if (!driver.active) {
    return res.status(403).json({ error: 'Your account has been deactivated. Contact support.' });
  }
  const token = auth.issueToken(driver.id);
  res.json({ driverId: driver.id, token, driver: { id: driver.id, name: driver.name, email: driver.email } });
});

app.get('/api/auth/me', auth.requireAuth, async (req, res) => {
  const driver = await driverWithHistory(req.driverId);
  if (!driver) return res.status(404).json({ error: 'driver not found' });
  res.json(driver);
});

app.post('/api/auth/change-password', auth.requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'currentPassword and newPassword are required' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });

  const driver = await prisma.driver.findUnique({ where: { id: req.driverId } });
  if (!(await auth.verifyPassword(currentPassword, driver.passwordHash))) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  const passwordHash = await auth.hashPassword(newPassword);
  await prisma.driver.update({ where: { id: req.driverId }, data: { passwordHash } });
  res.json({ ok: true });
});
// NOTE: there is deliberately no "forgot password" endpoint here — sending a
// reset email requires an email-sending service (SendGrid, Postmark, SES,
// etc.) that isn't configured anywhere in this project. Add one before
// shipping to real drivers, or they'll have no way back into a locked-out
// account.

app.get('/api/driver/:id', auth.requireAuth, auth.requireSelf, async (req, res) => {
  const d = await driverWithHistory(req.params.id);
  if (!d) return res.status(404).json({ error: 'driver not found' });
  res.json(d);
});

app.post('/api/rider/register', async (req, res) => {
  const name = (req.body && req.body.name) || 'Rider';
  const rider = await prisma.rider.create({ data: { name } });
  res.json({ riderId: rider.id, rider });
});

app.get('/api/rider/:id', async (req, res) => {
  const r = await prisma.rider.findUnique({ where: { id: req.params.id } });
  if (!r) return res.status(404).json({ error: 'rider not found' });
  res.json(r);
});

// ---------------------------------------------------------------------------
// Stripe Connect — driver payouts
// ---------------------------------------------------------------------------
app.post('/api/driver/:id/stripe/onboard-link', auth.requireAuth, auth.requireSelf, async (req, res) => {
  if (!stripe) return res.status(400).json({ error: 'Stripe is not configured on this server (missing STRIPE_SECRET_KEY).' });
  const driver = await prisma.driver.findUnique({ where: { id: req.params.id } });
  if (!driver) return res.status(404).json({ error: 'driver not found' });

  let accountId = driver.stripeAccountId;
  if (!accountId) {
    const account = await stripe.accounts.create({ type: 'express', capabilities: { transfers: { requested: true }, card_payments: { requested: true } } });
    accountId = account.id;
    await prisma.driver.update({ where: { id: driver.id }, data: { stripeAccountId: accountId } });
  }

  const origin = req.body.returnOrigin || (allowedOrigins.includes('*') ? 'http://localhost:8080' : allowedOrigins[0]);
  const accountLink = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: `${origin}/?stripe=refresh`,
    return_url: `${origin}/?stripe=return`,
    type: 'account_onboarding',
  });
  res.json({ url: accountLink.url });
});

app.get('/api/driver/:id/stripe/status', auth.requireAuth, auth.requireSelf, async (req, res) => {
  const driver = await prisma.driver.findUnique({ where: { id: req.params.id } });
  if (!driver) return res.status(404).json({ error: 'driver not found' });
  if (!stripe || !driver.stripeAccountId) return res.json({ connected: false, payoutsEnabled: false });

  const account = await stripe.accounts.retrieve(driver.stripeAccountId);
  const payoutsEnabled = !!account.payouts_enabled;
  await prisma.driver.update({ where: { id: driver.id }, data: { payoutsEnabled } });
  res.json({ connected: true, payoutsEnabled, detailsSubmitted: !!account.details_submitted });
});

// ---------------------------------------------------------------------------
// Stripe — rider payment methods
// ---------------------------------------------------------------------------
app.post('/api/rider/:id/stripe/setup-intent', async (req, res) => {
  if (!stripe) return res.status(400).json({ error: 'Stripe is not configured on this server (missing STRIPE_SECRET_KEY).' });
  const rider = await prisma.rider.findUnique({ where: { id: req.params.id } });
  if (!rider) return res.status(404).json({ error: 'rider not found' });

  let customerId = rider.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({ name: rider.name });
    customerId = customer.id;
    await prisma.rider.update({ where: { id: rider.id }, data: { stripeCustomerId: customerId } });
  }

  const setupIntent = await stripe.setupIntents.create({ customer: customerId, payment_method_types: ['card'] });
  res.json({ clientSecret: setupIntent.client_secret, customerId });
});

app.post('/api/rider/:id/stripe/confirm-payment-method', async (req, res) => {
  if (!stripe) return res.status(400).json({ error: 'Stripe is not configured on this server.' });
  const { paymentMethodId } = req.body;
  const rider = await prisma.rider.findUnique({ where: { id: req.params.id } });
  if (!rider || !rider.stripeCustomerId) return res.status(404).json({ error: 'rider or Stripe customer not found' });

  await stripe.customers.update(rider.stripeCustomerId, { invoice_settings: { default_payment_method: paymentMethodId } });
  const pm = await stripe.paymentMethods.retrieve(paymentMethodId);

  const updated = await prisma.rider.update({
    where: { id: rider.id },
    data: { defaultPaymentMethodId: paymentMethodId, cardBrand: pm.card.brand, cardLast4: pm.card.last4 },
  });
  res.json({ cardBrand: updated.cardBrand, cardLast4: updated.cardLast4 });
});

// ---------------------------------------------------------------------------
// Driver application — personal/demographic info, license, insurance,
// vehicle details, document uploads, and Checkr background check status.
// A driver cannot go online (see driver:online below) until this reaches
// status "approved".
// ---------------------------------------------------------------------------

const DOC_FIELD_MAP = {
  licenseFront: 'licenseFrontKey',
  licenseBack: 'licenseBackKey',
  insuranceDoc: 'insuranceDocKey',
  registrationDoc: 'registrationDocKey',
  vehiclePhotoFront: 'vehiclePhotoFrontKey',
  vehiclePhotoBack: 'vehiclePhotoBackKey',
  vehiclePhotoLeft: 'vehiclePhotoLeftKey',
  vehiclePhotoRight: 'vehiclePhotoRightKey',
};

async function getOrCreateApplication(driverId) {
  const existing = await prisma.driverApplication.findUnique({ where: { driverId } });
  if (existing) return existing;
  return prisma.driverApplication.create({ data: { driverId } });
}

async function applicationWithDocUrls(application) {
  const docUrls = {};
  for (const [docType, field] of Object.entries(DOC_FIELD_MAP)) {
    const key = application[field];
    docUrls[docType] = key ? await documents.getDownloadUrl(key) : null;
  }
  return { ...application, docUrls };
}

app.get('/api/driver/:id/application', auth.requireAuth, auth.requireSelf, async (req, res) => {
  const application = await getOrCreateApplication(req.params.id);
  res.json(await applicationWithDocUrls(application));
});

// Upsert the text fields of the application (personal info, license,
// insurance, vehicle details). Documents are handled separately below.
app.put('/api/driver/:id/application', auth.requireAuth, auth.requireSelf, async (req, res) => {
  const application = await getOrCreateApplication(req.params.id);
  if (application.status !== 'draft') {
    return res.status(400).json({ error: 'This application has already been submitted and can no longer be edited.' });
  }

  const allowedFields = [
    'legalFirstName', 'legalLastName', 'dateOfBirth', 'phone', 'email',
    'addressLine1', 'addressLine2', 'city', 'state', 'zip',
    'licenseNumber', 'licenseState', 'licenseExpiration',
    'insuranceProvider', 'insurancePolicyNum', 'insuranceExpiration',
    'vehicleMake', 'vehicleModel', 'vehicleYear', 'vehicleColor', 'licensePlate', 'vin',
  ];
  const data = {};
  for (const field of allowedFields) {
    if (field in req.body) data[field] = req.body[field];
  }

  const updated = await prisma.driverApplication.update({ where: { id: application.id }, data });
  res.json(await applicationWithDocUrls(updated));
});

app.post('/api/driver/:id/application/documents/upload-url', auth.requireAuth, auth.requireSelf, async (req, res) => {
  if (!documents.isConfigured()) return res.status(400).json({ error: 'Document storage is not configured on this server (missing S3_BUCKET).' });
  const { docType } = req.body;
  try {
    const { uploadUrl, key } = await documents.getUploadUrl(req.params.id, docType);
    res.json({ uploadUrl, key });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/driver/:id/application/documents/confirm', auth.requireAuth, auth.requireSelf, async (req, res) => {
  const { docType, key } = req.body;
  const field = DOC_FIELD_MAP[docType];
  if (!field) return res.status(400).json({ error: `Unknown document type: ${docType}` });

  const application = await getOrCreateApplication(req.params.id);
  const updated = await prisma.driverApplication.update({
    where: { id: application.id },
    data: { [field]: key },
  });
  res.json(await applicationWithDocUrls(updated));
});

app.post('/api/driver/:id/application/submit', auth.requireAuth, auth.requireSelf, async (req, res) => {
  const application = await getOrCreateApplication(req.params.id);
  const driver = await prisma.driver.findUnique({ where: { id: req.params.id } });

  const required = [
    'legalFirstName', 'legalLastName', 'dateOfBirth', 'phone', 'email',
    'addressLine1', 'city', 'state', 'zip',
    'licenseNumber', 'licenseState', 'licenseExpiration', 'licenseFrontKey',
    'insuranceProvider', 'insurancePolicyNum', 'insuranceExpiration', 'insuranceDocKey',
    'vehicleMake', 'vehicleModel', 'vehicleYear', 'licensePlate', 'vin', 'registrationDocKey',
    'vehiclePhotoFrontKey', 'vehiclePhotoBackKey', 'vehiclePhotoLeftKey', 'vehiclePhotoRightKey',
  ];
  const missing = required.filter((f) => !application[f]);
  if (missing.length) {
    return res.status(400).json({ error: 'Application is incomplete.', missing });
  }

  let checkrFields = {};
  if (checkr.isConfigured()) {
    try {
      const candidate = await checkr.createCandidate({
        firstName: application.legalFirstName,
        lastName: application.legalLastName,
        email: application.email,
        phone: application.phone,
      });
      const invitation = await checkr.createInvitation(candidate.id, application.checkrPackage);
      checkrFields = {
        checkrCandidateId: candidate.id,
        checkrInvitationId: invitation.id,
        checkrInvitationUrl: invitation.invitation_url,
      };
    } catch (err) {
      return res.status(502).json({ error: `Could not start the background check: ${err.message}` });
    }
  }

  const updated = await prisma.driverApplication.update({
    where: { id: application.id },
    data: { status: 'submitted', submittedAt: new Date(), ...checkrFields },
  });
  res.json(await applicationWithDocUrls(updated));
});

// ---------------------------------------------------------------------------
// Ratings & feedback — riders rate a completed trip (1-5 stars + optional
// written comment). Riders have no auth in this app, so ownership is
// checked loosely (the riderId provided must match the one on the trip) —
// consistent with the rest of the rider-side design, not a real auth check.
// ---------------------------------------------------------------------------
app.post('/api/trip/:tripRecordId/rate', async (req, res) => {
  const { riderId, rating, comment } = req.body || {};
  if (!riderId || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'riderId and an integer rating from 1-5 are required.' });
  }

  const trip = await prisma.tripRecord.findUnique({ where: { id: req.params.tripRecordId } });
  if (!trip) return res.status(404).json({ error: 'trip not found' });
  if (trip.riderId !== riderId) return res.status(403).json({ error: 'This trip does not belong to that rider.' });
  if (trip.rating != null) return res.status(409).json({ error: 'This trip has already been rated.' });

  const updated = await prisma.tripRecord.update({
    where: { id: trip.id },
    data: { rating, ratingComment: comment || null },
  });

  // Push it to the driver live if they're online, instead of only showing
  // up next time they happen to check their insights.
  if (driverSockets[trip.driverId]) {
    io.to(driverSockets[trip.driverId]).emit('trip:rated', {
      rating: updated.rating, comment: updated.ratingComment, riderName: trip.riderName,
    });
  }
  if (rating === 5) await awardPoints(trip.driverId, 5);

  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Tips — a separate charge from the fare, 100% to the driver. Unlike the
// fare split (60/20/20), there is deliberately no application_fee_amount
// here: Nexgen takes no cut of tips.
// ---------------------------------------------------------------------------
app.post('/api/trip/:tripRecordId/tip', async (req, res) => {
  const { riderId, amount } = req.body || {};
  const amountNum = Number(amount);
  if (!riderId || !Number.isFinite(amountNum) || amountNum <= 0) {
    return res.status(400).json({ error: 'riderId and a positive amount are required.' });
  }

  const trip = await prisma.tripRecord.findUnique({ where: { id: req.params.tripRecordId } });
  if (!trip) return res.status(404).json({ error: 'trip not found' });
  if (trip.riderId !== riderId) return res.status(403).json({ error: 'This trip does not belong to that rider.' });
  if (trip.tipAmount > 0) return res.status(409).json({ error: 'This trip already has a tip.' });

  if (!stripe) return res.status(400).json({ error: 'Payments are not configured on this server.' });

  const [rider, driver] = await Promise.all([
    prisma.rider.findUnique({ where: { id: riderId } }),
    prisma.driver.findUnique({ where: { id: trip.driverId } }),
  ]);
  if (!rider || !rider.stripeCustomerId || !rider.defaultPaymentMethodId) {
    return res.status(400).json({ error: 'No saved payment method on file for this rider.' });
  }
  if (!driver || !driver.stripeAccountId || !driver.payoutsEnabled) {
    return res.status(400).json({ error: "This driver hasn't finished payout setup yet, so tips can't be transferred." });
  }

  let tipStatus = 'failed';
  let paymentIntentId = null;
  try {
    const amountCents = Math.round(amountNum * 100);
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      customer: rider.stripeCustomerId,
      payment_method: rider.defaultPaymentMethodId,
      off_session: true,
      confirm: true,
      transfer_data: { destination: driver.stripeAccountId }, // no application_fee_amount — 100% to the driver
      description: `Tip for Nexgen trip ${trip.id}`,
    });
    paymentIntentId = paymentIntent.id;
    tipStatus = paymentIntent.status === 'succeeded' ? 'succeeded' : paymentIntent.status;
  } catch (err) {
    return res.status(402).json({ error: 'Tip payment failed — the card was declined or needs authentication.' });
  }

  const updated = await prisma.tripRecord.update({
    where: { id: trip.id },
    data: { tipAmount: amountNum, tipPaymentIntentId: paymentIntentId, tipStatus },
  });

  if (tipStatus === 'succeeded') {
    await prisma.driver.update({ where: { id: trip.driverId }, data: { earnings: { increment: amountNum } } });
    await awardPoints(trip.driverId, 2);
  }

  if (driverSockets[trip.driverId]) {
    io.to(driverSockets[trip.driverId]).emit('trip:tipped', { amount: updated.tipAmount, riderName: trip.riderName });
  }

  res.json({ ok: true, tipStatus, tipAmount: updated.tipAmount });
});

// ---------------------------------------------------------------------------
// Driver insights — rating average, acceptance rate, cancel rate, and
// recent rider comments. Rates are computed from the counters incremented
// directly in the socket handlers above, not recomputed from full history
// each time (cheap at any scale).
// ---------------------------------------------------------------------------
app.get('/api/driver/:id/insights', auth.requireAuth, auth.requireSelf, async (req, res) => {
  const driver = await prisma.driver.findUnique({ where: { id: req.params.id } });
  if (!driver) return res.status(404).json({ error: 'driver not found' });

  const ratingAgg = await prisma.tripRecord.aggregate({
    where: { driverId: driver.id, rating: { not: null } },
    _avg: { rating: true },
    _count: { rating: true },
  });

  const recentComments = await prisma.tripRecord.findMany({
    where: { driverId: driver.id, ratingComment: { not: null } },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { rating: true, ratingComment: true, riderName: true, createdAt: true },
  });

  const tipAgg = await prisma.tripRecord.aggregate({
    where: { driverId: driver.id, tipStatus: 'succeeded' },
    _sum: { tipAmount: true },
    _count: { tipAmount: true },
  });
  const recentTips = await prisma.tripRecord.findMany({
    where: { driverId: driver.id, tipStatus: 'succeeded', tipAmount: { gt: 0 } },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { tipAmount: true, riderName: true, createdAt: true },
  });

  const acceptanceRate = driver.requestsReceived > 0
    ? +((driver.requestsAccepted / driver.requestsReceived) * 100).toFixed(1)
    : null;
  const cancelRate = driver.requestsAccepted > 0
    ? +((driver.tripsCancelled / driver.requestsAccepted) * 100).toFixed(1)
    : null;

  const currentTier = tierForPoints(driver.rewardPoints);
  const nextTier = nextTierForPoints(driver.rewardPoints);

  res.json({
    avgRating: ratingAgg._avg.rating ? +ratingAgg._avg.rating.toFixed(2) : null,
    ratingCount: ratingAgg._count.rating,
    acceptanceRate,
    cancelRate,
    requestsReceived: driver.requestsReceived,
    requestsAccepted: driver.requestsAccepted,
    requestsDeclined: driver.requestsDeclined,
    tripsCancelled: driver.tripsCancelled,
    totalTips: +(tipAgg._sum.tipAmount || 0).toFixed(2),
    tipCount: tipAgg._count.tipAmount,
    recentTips: recentTips.map((t) => ({ amount: t.tipAmount, riderName: t.riderName, date: t.createdAt.getTime() })),
    recentComments: recentComments.map((c) => ({
      rating: c.rating, comment: c.ratingComment, riderName: c.riderName, date: c.createdAt.getTime(),
    })),
    rewardPoints: driver.rewardPoints,
    rewardTier: currentTier ? currentTier.name : null,
    nextRewardTier: nextTier ? nextTier.name : null,
    pointsToNextTier: nextTier ? nextTier.threshold - driver.rewardPoints : null,
    rewardTiers: REWARD_TIERS,
  });
});

// ---------------------------------------------------------------------------
// Admin — real accounts (email/password, JWT with role:'admin'), not the
// earlier shared-token scheme. Creating an admin account requires
// ADMIN_SETUP_KEY, a server-side secret — this is deliberately not open
// self-registration.
// ---------------------------------------------------------------------------
app.post('/api/admin/auth/register', async (req, res) => {
  const { name, email, password, setupKey } = req.body || {};
  if (!process.env.ADMIN_SETUP_KEY) return res.status(503).json({ error: 'Admin registration is not configured on this server.' });
  if (setupKey !== process.env.ADMIN_SETUP_KEY) return res.status(401).json({ error: 'Invalid setup key.' });
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email, and password are required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  const existing = await prisma.admin.findUnique({ where: { email: email.toLowerCase() } });
  if (existing) return res.status(409).json({ error: 'An admin with this email already exists.' });

  const passwordHash = await auth.hashPassword(password);
  const admin = await prisma.admin.create({ data: { name, email: email.toLowerCase(), passwordHash } });
  const token = auth.issueAdminToken(admin.id);
  res.json({ adminId: admin.id, token, admin: { id: admin.id, name: admin.name, email: admin.email } });
});

app.post('/api/admin/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

  const admin = await prisma.admin.findUnique({ where: { email: email.toLowerCase() } });
  if (!admin || !(await auth.verifyPassword(password, admin.passwordHash))) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  const token = auth.issueAdminToken(admin.id);
  res.json({ adminId: admin.id, token, admin: { id: admin.id, name: admin.name, email: admin.email } });
});

app.get('/api/admin/auth/me', auth.requireAdminAuth, async (req, res) => {
  const admin = await prisma.admin.findUnique({ where: { id: req.adminId } });
  if (!admin) return res.status(404).json({ error: 'admin not found' });
  res.json({ id: admin.id, name: admin.name, email: admin.email });
});

// ---- Reviewing and approving/rejecting applications ----
app.get('/api/admin/applications', auth.requireAdminAuth, async (req, res) => {
  const where = req.query.status ? { status: req.query.status } : {};
  const applications = await prisma.driverApplication.findMany({
    where,
    include: { driver: { select: { id: true, name: true, active: true } } },
    orderBy: { submittedAt: 'desc' },
  });
  res.json(applications);
});

app.get('/api/admin/applications/:id', auth.requireAdminAuth, async (req, res) => {
  const application = await prisma.driverApplication.findUnique({
    where: { id: req.params.id },
    include: { driver: { select: { id: true, name: true, active: true } } },
  });
  if (!application) return res.status(404).json({ error: 'not found' });
  res.json(await applicationWithDocUrls(application));
});

app.post('/api/admin/applications/:id/decision', auth.requireAdminAuth, async (req, res) => {
  const { decision, notes } = req.body; // decision: 'approved' | 'rejected'
  if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'decision must be approved or rejected' });

  const admin = await prisma.admin.findUnique({ where: { id: req.adminId } });
  const updated = await prisma.driverApplication.update({
    where: { id: req.params.id },
    data: { status: decision, reviewNotes: notes || null, reviewedBy: admin ? admin.name : null, reviewedAt: new Date() },
  });

  // Push the decision to the driver immediately over the socket, instead of
  // them only finding out the next time the app happens to re-check.
  if (driverSockets[updated.driverId]) {
    io.to(driverSockets[updated.driverId]).emit('application:decision', {
      status: updated.status,
      reviewNotes: updated.reviewNotes,
    });
  }

  res.json(updated);
});

// ---- Deactivating / reactivating driver accounts ----
app.post('/api/admin/drivers/:id/deactivate', auth.requireAdminAuth, async (req, res) => {
  const driver = await prisma.driver.update({ where: { id: req.params.id }, data: { active: false, online: false } }).catch(() => null);
  if (!driver) return res.status(404).json({ error: 'driver not found' });

  // Force them out immediately, don't wait for their token to expire or
  // for them to happen to reconnect.
  const socketId = driverSockets[driver.id];
  if (socketId) {
    io.to(socketId).emit('account:deactivated', { reason: 'Your account has been deactivated. Contact support.' });
    io.sockets.sockets.get(socketId)?.disconnect(true);
    delete driverSockets[driver.id];
  }
  res.json({ id: driver.id, active: driver.active });
});

app.post('/api/admin/drivers/:id/reactivate', auth.requireAdminAuth, async (req, res) => {
  const driver = await prisma.driver.update({ where: { id: req.params.id }, data: { active: true } }).catch(() => null);
  if (!driver) return res.status(404).json({ error: 'driver not found' });
  res.json({ id: driver.id, active: driver.active });
});

// ---------------------------------------------------------------------------
// Real-time layer
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  // ---- Driver events ----
  // driver:join now takes a JWT instead of a bare driverId — the token is
  // the only source of truth for who this socket is allowed to act as.
  // Every other driver:* / request:* / trip:* handler below uses
  // socket.driverId (set here after verifying the token) instead of
  // trusting whatever driverId a client might send in the event payload.
  socket.on('driver:join', async ({ token }) => {
    const payload = auth.verifyToken(token);
    if (!payload) {
      socket.emit('auth:error', { error: 'Your session has expired. Please log in again.' });
      return;
    }
    const d = await driverWithHistory(payload.driverId);
    if (!d) return;
    if (!d.active) {
      socket.emit('account:deactivated', { reason: 'Your account has been deactivated. Contact support.' });
      return;
    }
    driverSockets[payload.driverId] = socket.id;
    socket.driverId = payload.driverId;
    socket.emit('driver:state', d);
  });

  socket.on('driver:online', async ({ lat, lng }) => {
    const driverId = socket.driverId;
    if (!driverId) return;

    const driver = await prisma.driver.findUnique({ where: { id: driverId } });
    if (!driver || !driver.active) {
      socket.emit('driver:onlineRejected', {
        reason: 'Your account has been deactivated. Contact support.',
        applicationStatus: 'deactivated',
      });
      return;
    }

    const application = await prisma.driverApplication.findUnique({ where: { driverId } });
    if (!application || application.status !== 'approved') {
      socket.emit('driver:onlineRejected', {
        reason: !application || application.status === 'draft'
          ? 'Complete your driver application before going online.'
          : `Your application is ${application.status.replace('_', ' ')} — you can't go online yet.`,
        applicationStatus: application ? application.status : 'draft',
      });
      return;
    }
    await prisma.driver.update({ where: { id: driverId }, data: { online: true, lat, lng } }).catch(() => {});
  });

  socket.on('driver:offline', async () => {
    const driverId = socket.driverId;
    if (!driverId) return;
    await prisma.driver.update({ where: { id: driverId }, data: { online: false } }).catch(() => {});
  });

  socket.on('driver:location', async ({ lat, lng }) => {
    const driverId = socket.driverId;
    if (!driverId) return;
    const d = await prisma.driver.update({ where: { id: driverId }, data: { lat, lng } }).catch(() => null);
    if (!d || !d.activeRideId) return;
    const ride = await prisma.ride.findUnique({ where: { id: d.activeRideId } });
    if (ride && riderSockets[ride.riderId]) {
      io.to(riderSockets[ride.riderId]).emit('driver:position', { lat, lng });
    }
  });

  socket.on('request:accept', async ({ requestId }) => {
    const driverId = socket.driverId;
    if (!driverId) return;
    const ride = await prisma.ride.update({ where: { id: requestId }, data: { status: 'accepted' } }).catch(() => null);
    const d = await prisma.driver.update({ where: { id: driverId }, data: { requestsAccepted: { increment: 1 } } }).catch(() => null);
    if (!ride || !d) return;

    const rider = await prisma.rider.findUnique({ where: { id: ride.riderId } });
    if (driverSockets[driverId]) io.to(driverSockets[driverId]).emit('trip:assigned', toRideDTO(ride, rider && rider.name));
    if (riderSockets[ride.riderId]) {
      io.to(riderSockets[ride.riderId]).emit('ride:accepted', {
        rideId: ride.id,
        driverName: d.name,
        pickup: { lat: ride.pickupLat, lng: ride.pickupLng },
        drop: { lat: ride.dropLat, lng: ride.dropLng, label: ride.dropLabel },
        driverLat: d.lat,
        driverLng: d.lng,
      });
    }
  });

  socket.on('request:decline', async ({ requestId }) => {
    const driverId = socket.driverId;
    if (!driverId) return;
    const ride = await prisma.ride.findUnique({ where: { id: requestId } });
    if (!ride) return;

    await prisma.driver.update({
      where: { id: driverId },
      data: { activeRideId: null, requestsDeclined: { increment: 1 } },
    }).catch(() => {});
    const tried = [...(ride.declinedBy || []), driverId];
    const match = await matchDriver(ride.pickupLat, ride.pickupLng, tried);

    if (match.driver) {
      const updated = await prisma.ride.update({
        where: { id: requestId },
        data: {
          declinedBy: tried, driverId: match.driver.id,
          dispatchMode: match.mode, matchDistanceKm: match.distanceKm, matchDurationMin: match.durationMin,
        },
      });
      await prisma.driver.update({ where: { id: match.driver.id }, data: { activeRideId: updated.id, requestsReceived: { increment: 1 } } });
      const rider = await prisma.rider.findUnique({ where: { id: ride.riderId } });
      if (driverSockets[match.driver.id]) io.to(driverSockets[match.driver.id]).emit('request:new', toRideDTO(updated, rider && rider.name));
    } else {
      await prisma.ride.update({ where: { id: requestId }, data: { status: 'no_drivers', declinedBy: tried } });
      if (riderSockets[ride.riderId]) io.to(riderSockets[ride.riderId]).emit('ride:noDrivers');
    }
  });

  // Driver-initiated cancellation — after accepting but before completing a
  // trip. Counts toward cancelRate separately from a decline (which happens
  // before ever accepting).
  socket.on('trip:cancel', async ({ requestId }) => {
    const driverId = socket.driverId;
    if (!driverId) return;
    const ride = await prisma.ride.update({
      where: { id: requestId },
      data: { status: 'cancelled_by_driver' },
    }).catch(() => null);
    if (!ride) return;

    await prisma.driver.update({
      where: { id: driverId },
      data: { activeRideId: null, tripsCancelled: { increment: 1 } },
    }).catch(() => {});

    if (riderSockets[ride.riderId]) {
      io.to(riderSockets[ride.riderId]).emit('ride:cancelledByDriver');
    }
  });

  socket.on('trip:arrived', async ({ requestId }) => {
    if (!socket.driverId) return;
    const ride = await prisma.ride.findUnique({ where: { id: requestId } });
    if (ride && riderSockets[ride.riderId]) io.to(riderSockets[ride.riderId]).emit('ride:driverArrived');
  });

  socket.on('trip:started', async ({ requestId }) => {
    if (!socket.driverId) return;
    const ride = await prisma.ride.update({ where: { id: requestId }, data: { status: 'in_progress' } }).catch(() => null);
    if (ride && riderSockets[ride.riderId]) io.to(riderSockets[ride.riderId]).emit('ride:started');
  });

  socket.on('trip:complete', async ({ requestId, distanceKm, durationMin }) => {
    const driverId = socket.driverId;
    if (!driverId) return;
    const ride = await prisma.ride.findUnique({ where: { id: requestId } });
    if (!ride) return;

    const fare = await computeFare(distanceKm, durationMin);
    const { total, base, distFare, timeFare, gasPricePerGallon, gasPriceSource, fuelCostPerKm } = fare;

    // Attempt a real charge only if both sides have completed Stripe setup.
    // Otherwise the trip still completes normally — payment is just skipped,
    // which keeps the demo usable without forcing Stripe setup first.
    const driverRecord = await prisma.driver.findUnique({ where: { id: driverId } });
    const riderRecord = await prisma.rider.findUnique({ where: { id: ride.riderId } });

    let paymentIntentId = null;
    let paymentStatus = 'skipped';
    let cardBrand = null;
    let cardLast4 = null;

    // Split is computed up front regardless of whether a real Stripe charge
    // happens, so driver earnings and trip history are always consistent.
    const amountCents = Math.round(total * 100);
    const driverCents = Math.round(amountCents * DRIVER_PCT);
    const applicationFeeCents = amountCents - driverCents; // guarantees the two sum to the full amount
    const platformCents = Math.round(amountCents * PLATFORM_PCT);
    const feesInsuranceCents = applicationFeeCents - platformCents; // absorbs rounding so platform+fees = applicationFee exactly

    const driverPayout = driverCents / 100;
    const platformFee = platformCents / 100;
    const insuranceFee = feesInsuranceCents / 100;

    const canCharge = stripe && driverRecord && driverRecord.stripeAccountId && driverRecord.payoutsEnabled &&
      riderRecord && riderRecord.stripeCustomerId && riderRecord.defaultPaymentMethodId;

    if (canCharge) {
      try {
        const paymentIntent = await stripe.paymentIntents.create({
          amount: amountCents,
          currency: 'usd',
          customer: riderRecord.stripeCustomerId,
          payment_method: riderRecord.defaultPaymentMethodId,
          off_session: true,
          confirm: true,
          // Stripe only knows about a 2-way split: this application fee
          // (platform's 20% + the 20% fees/insurance reserve, 40% combined)
          // stays in Nexgen's own Stripe balance; the rest transfers to the
          // driver. The platform/fees-insurance breakdown within that 40%
          // is Nexgen's own bookkeeping (see TripRecord below) — Stripe has
          // no concept of a third destination account for it.
          application_fee_amount: applicationFeeCents,
          transfer_data: { destination: driverRecord.stripeAccountId },
          description: `Nexgen ride ${ride.id}`,
        });
        paymentIntentId = paymentIntent.id;
        paymentStatus = paymentIntent.status === 'succeeded' ? 'succeeded' : paymentIntent.status;
        cardBrand = riderRecord.cardBrand;
        cardLast4 = riderRecord.cardLast4;
      } catch (err) {
        // Card declined, requires 3D Secure authentication the rider isn't
        // present to complete, etc. The trip still completes; the fare is
        // recorded as unpaid rather than blocking the driver.
        paymentStatus = err.code === 'authentication_required' ? 'requires_action' : 'failed';
      }
    }

    const tripRecord = await prisma.tripRecord.create({
      data: {
        driverId, riderId: ride.riderId, riderName: riderRecord ? riderRecord.name : null,
        pickupLabel: ride.pickupLabel, dropLabel: ride.dropLabel, fare: total,
        distanceKm, durationMin, paymentIntentId, paymentStatus,
        driverPayout, platformFee, insuranceFee,
        gasPricePerGallon, fuelCostPerKm,
      },
    });
    const driverBefore = await prisma.driver.findUnique({ where: { id: driverId }, select: { rewardPoints: true } });
    const tripPoints = pointsForTripCompletion();
    const isBonusTrip = tripPoints > 1;
    const driver = await prisma.driver.update({
      where: { id: driverId },
      // Earnings reflect the driver's actual 60% take-home, not the full fare.
      // 1 point normally, 3 during a bonus window — see pointsForTripCompletion above.
      data: { earnings: { increment: driverPayout }, trips: { increment: 1 }, activeRideId: null, rewardPoints: { increment: tripPoints } },
    });
    await prisma.ride.update({ where: { id: requestId }, data: { status: 'completed' } });

    if (driverBefore) {
      const beforeTier = tierForPoints(driverBefore.rewardPoints);
      const afterTier = tierForPoints(driver.rewardPoints);
      if (afterTier && afterTier.name !== (beforeTier && beforeTier.name)) {
        socket.emit('reward:tierUp', { tier: afterTier.name, points: driver.rewardPoints });
      }
    }

    const result = {
      total, base, distFare: +distFare.toFixed(2), timeFare: +timeFare.toFixed(2),
      distanceKm, durationMin, driver, paymentStatus,
      driverPayout, platformFee, insuranceFee,
      tripPoints, isBonusTrip,
      gasPricePerGallon, gasPriceSource, fuelCostPerKm,
    };
    socket.emit('trip:finalized', result);

    if (riderSockets[ride.riderId]) {
      io.to(riderSockets[ride.riderId]).emit('ride:completed', {
        total, base, distFare: result.distFare, timeFare: result.timeFare, distanceKm, durationMin,
        paymentStatus, cardBrand, cardLast4, tripRecordId: tripRecord.id, driverName: driver.name,
        gasPricePerGallon, fuelCostPerKm,
      });
    }
  });

  // ---- Rider events ----
  socket.on('rider:join', ({ riderId }) => {
    riderSockets[riderId] = socket.id;
    socket.riderId = riderId;
  });

  socket.on('rider:request', async ({ riderId, pickup, drop, pickupLabel, dropLabel }) => {
    const rider = await prisma.rider.update({ where: { id: riderId }, data: { lat: pickup.lat, lng: pickup.lng } }).catch(() => null);
    if (!rider) return;

    const match = await matchDriver(pickup.lat, pickup.lng);
    if (!match.driver) {
      socket.emit('ride:noDrivers');
      return;
    }

    const estDistanceKm = haversineKm(pickup.lat, pickup.lng, drop.lat, drop.lng);
    const ride = await prisma.ride.create({
      data: {
        riderId, driverId: match.driver.id,
        pickupLat: pickup.lat, pickupLng: pickup.lng,
        dropLat: drop.lat, dropLng: drop.lng,
        pickupLabel, dropLabel, estDistanceKm, status: 'pending',
        dispatchMode: match.mode, matchDistanceKm: match.distanceKm, matchDurationMin: match.durationMin,
      },
    });
    await prisma.driver.update({ where: { id: match.driver.id }, data: { activeRideId: ride.id, requestsReceived: { increment: 1 } } });

    socket.emit('ride:searching', { rideId: ride.id });
    if (driverSockets[match.driver.id]) io.to(driverSockets[match.driver.id]).emit('request:new', toRideDTO(ride, rider.name));
  });

  socket.on('rider:cancel', async ({ rideId, reason }) => {
    const ride = await prisma.ride.findUnique({ where: { id: rideId } });
    if (!ride) return;

    if (ride.driverId) {
      await prisma.driver.update({ where: { id: ride.driverId }, data: { activeRideId: null } }).catch(() => {});
      // Let the driver know immediately — and why — whether they'd already
      // accepted or were just still looking at the request. This does NOT
      // count against the driver's cancelRate; that's only for trips the
      // driver themselves cancels (see trip:cancel above).
      if (driverSockets[ride.driverId]) {
        io.to(driverSockets[ride.driverId]).emit('ride:cancelledByRider', { reason: reason || null });
      }
    }
    await prisma.ride.update({ where: { id: rideId }, data: { status: 'cancelled', cancelReason: reason || null } }).catch(() => {});
  });

  socket.on('disconnect', () => {
    // Sockets are transient; durable state lives in Postgres. A production
    // app would run a grace-period timer here before treating a dropped
    // driver connection as "went offline".
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Nexgen Driver App backend listening on :${PORT}`);
});
