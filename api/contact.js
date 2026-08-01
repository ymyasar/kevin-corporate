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

  console.log('[CONTACT] RECEIVED');

  // Honeypot — bot filled the hidden field, return silent 200 (no email sent)
  if (body.website) {
    console.log('[CONTACT] BLOCKED_HONEYPOT');
    return res.status(200).json({ ok: true });
  }

  // Timing guard — fail open: only block when elapsed is a positive value under 2000 ms.
  // If _ts is missing, unparseable, negative, or implausibly large (>1 hour), allow through.
  const ts = parseInt(body._ts, 10);
  const elapsed = isNaN(ts) ? -1 : Date.now() - ts;
  if (elapsed > 0 && elapsed < 2000) {
    console.log(`[CONTACT] BLOCKED_TIMING ${elapsed}ms`);
    return res.status(200).json({ ok: true });
  }

  // Required fields
  const missing = [];
  for (const field of ['name', 'email', 'session', 'message']) {
    const val = typeof body[field] === 'string' ? body[field].trim() : '';
    if (!val) missing.push(field);
  }
  if (missing.length) {
    console.log(`[CONTACT] VALIDATION_FAILED missing:${missing.join(',')}`);
    return res.status(400).json({ ok: false, error: `Missing required field: ${missing[0]}` });
  }

  // Length caps
  for (const [field, max] of Object.entries(FIELD_MAX)) {
    const val = body[field];
    if (val && String(val).length > max) {
      console.log(`[CONTACT] VALIDATION_FAILED field_too_long:${field}`);
      return res.status(400).json({ ok: false, error: `Field too long: ${field}` });
    }
  }

  // Email format
  if (!validEmail(body.email.trim())) {
    console.log('[CONTACT] VALIDATION_FAILED invalid_email');
    return res.status(400).json({ ok: false, error: 'Invalid email address' });
  }

  // Session type allowlist
  if (!SESSION_TYPES.has(body.session.trim())) {
    console.log('[CONTACT] VALIDATION_FAILED invalid_session');
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
    const { data, error } = await resend.emails.send({
      // TODO: switch back to inquiries@kevinheadshots.com once the domain is verified in Resend
      from: 'Kevin Nguyen Headshots <onboarding@resend.dev>',
      to: 'KevinHeadshots@gmail.com',
      bcc: 'yasar@rosettasystems.co',
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

    if (error || !data?.id) {
      console.error(`[CONTACT] RESEND_ERROR ${JSON.stringify(error)}`);
      return res.status(500).json({ ok: false, error: 'Email delivery failed' });
    }

    console.log(`[CONTACT] SENT ${data.id}`);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(`[CONTACT] RESEND_ERROR ${JSON.stringify(err?.message || err)}`);
    return res.status(500).json({ ok: false, error: 'Email delivery failed' });
  }
};
