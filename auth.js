const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const TOKEN_TTL = '30d';

function getSecret() {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not set. Generate one (e.g. `openssl rand -hex 32`) and set it as an env var / Fly secret.');
  }
  return process.env.JWT_SECRET;
}

async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function issueToken(driverId) {
  return jwt.sign({ driverId }, getSecret(), { expiresIn: TOKEN_TTL });
}

function issueAdminToken(adminId) {
  return jwt.sign({ adminId, role: 'admin' }, getSecret(), { expiresIn: TOKEN_TTL });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, getSecret());
  } catch {
    return null;
  }
}

/**
 * Express middleware: requires a valid `Authorization: Bearer <token>`
 * header and attaches `req.driverId`. This is the fix for a real gap in
 * earlier versions of this backend — every driver-scoped endpoint trusted
 * whatever :id was in the URL, so anyone who saw or guessed a driverId
 * could read or edit that person's application. Now the token itself is
 * the only source of truth for "who is this," and any endpoint that also
 * takes a :id in the URL additionally checks it matches the token (see
 * requireSelf below) rather than trusting the URL alone.
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing Authorization header' });

  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Invalid or expired token' });

  req.driverId = payload.driverId;
  next();
}

/** Use after requireAuth on routes shaped /api/driver/:id/... — ensures the
 * authenticated driver can only act on their own record. */
function requireSelf(req, res, next) {
  if (req.driverId !== req.params.id) return res.status(403).json({ error: 'Forbidden' });
  next();
}

/** Real admin auth — a distinct token type (role: 'admin'), not the driver
 * JWT and not the old shared ADMIN_TOKEN scheme. A driver's token can never
 * pass this check, and vice versa. */
function requireAdminAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing Authorization header' });

  const payload = verifyToken(token);
  if (!payload || payload.role !== 'admin' || !payload.adminId) {
    return res.status(401).json({ error: 'Invalid or expired admin session' });
  }
  req.adminId = payload.adminId;
  next();
}

module.exports = { hashPassword, verifyPassword, issueToken, issueAdminToken, verifyToken, requireAuth, requireSelf, requireAdminAuth };
