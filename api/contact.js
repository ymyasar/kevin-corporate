const { Resend } = require('resend');

const SESSION_TYPES = new Set([
  'Standard Headshot',
  'Enterprise Headshot',
  'Corporate Team',
  'Personal Branding',
  'Attorney / Law Firm',
  'Other',
]);

const FIELD_MAX = {
  name: 120,
  email: 254,
  phone: 30,
  company: 200,
  session: 60,
  message: 3000,
};

// In-memory per-IP throttle (resets on cold start — adequate for basic bot blocking)
const ipLog = new Map();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 3;

function isThrottled(ip) {
  const now = Date.now();
  const hits = (ipLog.get(ip) || []).filter(t => now - t < WINDOW_MS);
  if (hits.length >= MAX_PER_WINDOW) return true;
  hits.push(now);
  ipLog.set(ip, hits);
  return false;
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown';

  if (isThrottled(ip)) {
    return res.status(429).json({ ok: false, error: 'Too many requests' });
  }

  const body = req.body || {};

  // Honeypot — bot filled the hidden field, return fake success
  if (body.website) {
    return res.status(200).json({ ok: true });
  }

  // Timestamp — reject submissions arriving faster than 3 seconds after page load
  const ts = parseInt(body._ts, 10);
  if (!ts || Date.now() - ts < 3000) {
    return res.status(200).json({ ok: true });
  }

  // Required fields
  for (const field of ['name', 'email', 'session', 'message']) {
    const val = typeof body[field] === 'string' ? body[field].trim() : '';
    if (!val) {
      return res.status(400).json({ ok: false, error: `Missing required field: ${field}` });
    }
  }

  // Length caps
  for (const [field, max] of Object.entries(FIELD_MAX)) {
    const val = body[field];
    if (val && String(val).length > max) {
      return res.status(400).json({ ok: false, error: `Field too long: ${field}` });
    }
  }

  // Email format
  if (!validEmail(body.email.trim())) {
    return res.status(400).json({ ok: false, error: 'Invalid email address' });
  }

  // Session type allowlist
  if (!SESSION_TYPES.has(body.session.trim())) {
    return res.status(400).json({ ok: false, error: 'Invalid session type' });
  }

  const name = body.name.trim();
  const email = body.email.trim();
  const phone = body.phone ? body.phone.trim() : '—';
  const company = body.company ? body.company.trim() : '—';
  const session = body.session.trim();
  const message = body.message.trim();

  const resend = new Resend(process.env.RESEND_API_KEY);

  try {
    await resend.emails.send({
      // TODO: switch back to inquiries@kevinheadshots.com once the domain is verified in Resend
      from: 'Kevin Nguyen Headshots <onboarding@resend.dev>',
      to: 'KevinHeadshots@gmail.com',
      replyTo: email,
      subject: `New inquiry — ${session} — ${name}`,
      text: [
        `Name:    ${name}`,
        `Email:   ${email}`,
        `Phone:   ${phone}`,
        `Company: ${company}`,
        `Session: ${session}`,
        '',
        'Message:',
        message,
      ].join('\n'),
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Resend error:', err?.message || err);
    return res.status(500).json({ ok: false, error: 'Email delivery failed' });
  }
};
