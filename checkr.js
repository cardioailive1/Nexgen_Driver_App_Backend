// Checkr integration using their hosted Invitation flow: we create a
// candidate with basic info, then create an invitation, and send the driver
// to Checkr's own page to finish the rest (including SSN) and give consent.
// This deliberately keeps SSN and the FCRA disclosure/consent flow entirely
// on Checkr's side — this backend never touches either.
//
// Docs: https://docs.checkr.com/

const CHECKR_API_BASE = 'https://api.checkr.com/v1';

function isConfigured() {
  return !!process.env.CHECKR_API_KEY;
}

function authHeader() {
  // Checkr uses HTTP Basic auth with the API key as the username, no password.
  const token = Buffer.from(`${process.env.CHECKR_API_KEY}:`).toString('base64');
  return `Basic ${token}`;
}

async function checkrRequest(path, options = {}) {
  const res = await fetch(`${CHECKR_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Checkr request failed: ${res.status}`);
  }
  return data;
}

async function createCandidate({ firstName, lastName, email, phone }) {
  return checkrRequest('/candidates', {
    method: 'POST',
    body: JSON.stringify({
      first_name: firstName,
      last_name: lastName,
      email,
      phone,
    }),
  });
}

async function createInvitation(candidateId, packageName) {
  return checkrRequest('/invitations', {
    method: 'POST',
    body: JSON.stringify({
      candidate_id: candidateId,
      package: packageName,
    }),
  });
}

async function getCandidate(candidateId) {
  return checkrRequest(`/candidates/${candidateId}`);
}

module.exports = { isConfigured, createCandidate, createInvitation, getCandidate };
