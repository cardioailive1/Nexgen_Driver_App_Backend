// Gas price lookup for fuel-aware fare calculation.
//
// Source: the U.S. Energy Information Administration's free public API
// (https://www.eia.gov/opendata/), which publishes the national average
// retail price for regular gasoline weekly. Register for a free API key at
// https://www.eia.gov/opendata/register.php and set EIA_API_KEY.
//
// Two real limitations worth knowing before trusting this:
//   1. EIA's number is a WEEKLY NATIONAL AVERAGE, not real-time and not
//      local to wherever a given ride actually happens. Gas prices vary by
//      state/region far more than they change week to week, so this is a
//      reasonable proxy, not a precise local price.
//   2. If EIA_API_KEY isn't set, or the request fails, this falls back to
//      FALLBACK_GAS_PRICE_PER_GALLON (a fixed number you set), and every
//      fare calculation uses that instead — silently, unless you check
//      /api/fare/rates, which reports which source was actually used.

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // refetch at most once a day — prices don't move faster than that
let cache = { price: null, source: null, fetchedAt: 0 };

async function fetchFromEIA() {
  const apiKey = process.env.EIA_API_KEY;
  if (!apiKey) return null;

  const url = `https://api.eia.gov/v2/petroleum/pri/gnd/data/?api_key=${apiKey}&frequency=weekly&data[0]=value&facets[product][]=EPMR&facets[duoarea][]=NUS&sort[0][column]=period&sort[0][direction]=desc&length=1`;
  try {
    const res = await fetch(url);
    const json = await res.json();
    const value = json?.response?.data?.[0]?.value;
    if (typeof value === 'number' && value > 0) return value;
  } catch (err) {
    // network error, bad key, EIA outage, schema change — any of these
    // just fall through to the manual fallback price below.
  }
  return null;
}

/** Returns { pricePerGallon, source, fetchedAt } — source is 'eia' or
 * 'fallback' so callers (and /api/fare/rates) can be honest about which one
 * actually priced a given fare. */
async function getGasPrice() {
  const now = Date.now();
  if (cache.price != null && now - cache.fetchedAt < CACHE_TTL_MS) {
    return { pricePerGallon: cache.price, source: cache.source, fetchedAt: cache.fetchedAt };
  }

  const eiaPrice = await fetchFromEIA();
  if (eiaPrice != null) {
    cache = { price: eiaPrice, source: 'eia', fetchedAt: now };
  } else {
    const fallback = Number(process.env.FALLBACK_GAS_PRICE_PER_GALLON) || 3.50;
    cache = { price: fallback, source: 'fallback', fetchedAt: now };
  }
  return { pricePerGallon: cache.price, source: cache.source, fetchedAt: cache.fetchedAt };
}

module.exports = { getGasPrice };
