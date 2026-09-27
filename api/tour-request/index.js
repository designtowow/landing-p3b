/* ===========================================================================
   POST /api/tour-request
   Private-tour request from the Inquire form.

   1. Submits name / email / phone to the HubSpot form (keeps form-submission
      attribution and the visitor's tracking cookie).
   2. Upserts the contact by email and attaches a Note with the tour details
      (preferred date, agent, message) — these are not stored as properties.
   3. Emails the listing agent via Azure Communication Services, reply-to the
      visitor.

   Steps 2 and 3 are skipped (and logged) when their settings are missing, and
   a failure in one never blocks the others.

   App settings (Azure portal → Static Web App → Environment variables):
     HUBSPOT_TOKEN            HubSpot service key (Development → Keys → Service keys)
                              with crm.objects.contacts.read + .write — covers
                              the contact upsert and the note
     ACS_CONNECTION_STRING    Azure Communication Services connection string
     NOTIFY_TO                agent email(s), comma-separated
                              (falls back to inquiries@fairmountstreet.com)
     NOTIFY_FROM              verified ACS sender address
     SITE_URL                 optional; site origin for the email logo, e.g.
                              https://example.com (defaults to the request host)
   =========================================================================== */

const crypto = require('crypto');

const PORTAL_ID = '47119238';
const FORM_ID = process.env.HUBSPOT_FORM_ID || 'e0c31ff5-6c54-4eeb-b75e-e142510c9387';
const NOTIFY_TO = process.env.NOTIFY_TO || 'inquiries@fairmountstreet.com';
const NOTIFY_FROM = process.env.NOTIFY_FROM || 'DoNotReply@fairmountstreet.com'; // must be a MailFrom address on the ACS domain
const HUBSPOT_APP = 'https://app-na2.hubspot.com';
const SITE_DOMAIN = 'https://3310fairmountp3b.com'; // shown as "Submitted on" in the agent email
const TIME_ZONE = 'America/Chicago';

const LIMITS = { firstname: 100, lastname: 100, email: 254, phone: 40, preferred_date: 40, working_with_agent: 3, message: 3000 };

module.exports = async function (context, req) {
  const body = typeof req.body === 'object' && req.body ? req.body : {};

  // Honeypot: real visitors never see or fill this field
  if (body.website) {
    context.res = json(200, { ok: true });
    return;
  }

  const lead = {};
  for (const key of Object.keys(LIMITS)) {
    lead[key] = String(body[key] || '').trim().slice(0, LIMITS[key]);
  }

  if (!lead.firstname || !lead.lastname || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) {
    context.res = json(400, { ok: false, error: 'Please add your name and a valid email address.' });
    return;
  }

  const page = {
    hutk: typeof body.hutk === 'string' ? body.hutk : undefined,
    pageUri: typeof body.pageUri === 'string' ? body.pageUri.slice(0, 500) : undefined,
    pageName: typeof body.pageName === 'string' ? body.pageName.slice(0, 200) : undefined,
    ipAddress: clientIp(req)
  };

  // Context for the note and the agent email
  const meta = { submittedAt: new Date(), source: leadSource(body), origin: siteOrigin(req) };

  // What happened at each step. Returned in the response (status codes only,
  // never settings or secrets) so a skipped or failed step is visible in the
  // browser's network tab without digging through function logs.
  const steps = { form: 'pending', contact: 'skipped', note: 'skipped', email: 'skipped' };

  // 1. HubSpot form submission (no token needed)
  try {
    await submitForm(lead, page);
    steps.form = 'sent';
  } catch (err) {
    steps.form = failed(err);
    context.log.error('HubSpot form submission failed:', err.message);
  }

  // 2. Contact + note
  let contactId = null;
  if (process.env.HUBSPOT_TOKEN) {
    try {
      contactId = await upsertContact(lead);
      steps.contact = 'saved';
      await createNote(contactId, lead, meta);
      steps.note = 'created';
    } catch (err) {
      steps[contactId ? 'note' : 'contact'] = failed(err);
      context.log.error('HubSpot contact/note failed:', err.message);
    }
  } else {
    steps.contact = steps.note = 'skipped: HUBSPOT_TOKEN not set';
    context.log.warn('HUBSPOT_TOKEN not set — skipping note.');
  }

  // 3. Agent notification
  if (process.env.ACS_CONNECTION_STRING) {
    try {
      await sendEmail(lead, contactId, meta);
      steps.email = 'sent';
    } catch (err) {
      steps.email = failed(err);
      context.log.error('Agent notification email failed:', err.message);
    }
  } else {
    steps.email = 'skipped: ACS_CONNECTION_STRING not set';
    context.log.warn('ACS_CONNECTION_STRING not set — skipping agent email.');
  }

  context.log('Tour request steps:', JSON.stringify(steps));

  // The lead counts as captured if it reached HubSpot or the agent's inbox
  const captured = steps.form === 'sent' || contactId || steps.email === 'sent';
  context.res = captured
    ? json(200, { ok: true, steps })
    : json(502, { ok: false, error: 'Could not send your request.', steps });
};

// Short, non-sensitive summary of a failure, e.g. "failed: 403 MISSING_SCOPES"
function failed(err) {
  if (err.status || err.code) return ['failed:', err.status, err.code].filter(Boolean).join(' ');
  return 'failed: ' + String(err.message).slice(0, 80);
}

// Builds an Error carrying the HTTP status and the API's error code/category
async function apiError(label, res) {
  const text = await res.text();
  let code;
  try {
    const body = JSON.parse(text);
    code = body.category || (body.error && body.error.code) || (body.errors && body.errors[0] && body.errors[0].errorType);
  } catch (e) { /* not JSON */ }
  const err = new Error(label + ' ' + res.status + ' ' + text);
  err.status = res.status;
  err.code = code;
  return err;
}

/* --- HubSpot --------------------------------------------------------------- */

async function submitForm(lead, page) {
  const fields = ['firstname', 'lastname', 'email', 'phone']
    .filter((name) => lead[name])
    .map((name) => ({ name, value: lead[name] }));

  const context = {};
  for (const key of ['hutk', 'pageUri', 'pageName', 'ipAddress']) {
    if (page[key]) context[key] = page[key];
  }

  const res = await fetch(`https://api.hsforms.com/submissions/v3/integration/submit/${PORTAL_ID}/${FORM_ID}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields, context })
  });
  if (!res.ok) throw await apiError('form', res);
}

async function hubspot(path, payload) {
  const res = await fetch(`https://api.hubapi.com${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.HUBSPOT_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw await apiError(path, res);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

// Creates the contact, or updates the existing one with the same email
async function upsertContact(lead) {
  const properties = { email: lead.email, firstname: lead.firstname, lastname: lead.lastname };
  if (lead.phone) properties.phone = lead.phone;

  const data = await hubspot('/crm/v3/objects/contacts/batch/upsert', {
    inputs: [{ idProperty: 'email', id: lead.email, properties }]
  });
  const id = data.results && data.results[0] && data.results[0].id;
  if (!id) throw new Error('Upsert returned no contact id');
  return id;
}

async function createNote(contactId, lead, meta) {
  const rows = tourDetails(lead).concat(sourceDetails(meta).filter(([label]) => label !== 'Submitted'))
    .map(([label, value]) => `<strong>${escapeHtml(label)}:</strong> ${linkify(value)}`)
    .join('<br>');

  await hubspot('/crm/v3/objects/notes', {
    properties: {
      hs_timestamp: new Date().toISOString(),
      hs_note_body: `<p><strong>Private tour request — Penthouse 3B</strong></p><p>${rows}</p>`
    },
    associations: [{
      to: { id: contactId },
      // 202 = note → contact (HubSpot-defined association)
      types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }]
    }]
  });
}

/* --- Email (Azure Communication Services REST, HMAC-signed) ---------------- */

async function sendEmail(lead, contactId, meta) {
  const { endpoint, accesskey } = parseConnectionString(process.env.ACS_CONNECTION_STRING);
  const url = new URL(`${endpoint}/emails:send?api-version=2023-03-31`);

  const name = `${lead.firstname} ${lead.lastname}`;
  const contactLine = [lead.email, lead.phone].filter(Boolean).join(' · ');
  const details = tourDetails(lead);
  const source = sourceDetails(meta);
  const recordUrl = contactId ? `${HUBSPOT_APP}/contacts/${PORTAL_ID}/record/0-1/${contactId}` : null;

  // Tap-to-act links. Call/Text only when the phone number looks dialable.
  const tel = dialable(lead.phone);
  const replySubject = 'Your private tour of Penthouse 3B';
  const actions = [
    tel && ['Call', `tel:${tel}`],
    tel && ['Text', `sms:${tel}`],
    ['Email', `mailto:${encodeURIComponent(lead.email)}?subject=${encodeURIComponent(replySubject)}`]
  ].filter(Boolean);

  const plainText = [
    'New private tour request — Penthouse 3B',
    '',
    name,
    contactLine,
    '',
    ...details.map(([label, value]) => `${label}: ${value}`),
    '',
    'Lead source',
    ...source.map(([label, value]) => `${label}: ${textOf(value)}`),
    '',
    recordUrl ? `HubSpot contact: ${recordUrl}` : '',
    'Reply to this email to respond directly.'
  ].join('\n');

  const button = ([label, href]) => `
          <td style="padding:0 8px 8px 0">
            <a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 22px;background:#9C7A55;color:#FFFFFF;font-family:Arial,sans-serif;font-size:12px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;text-decoration:none">${label}</a>
          </td>`;

  const rows = (list, valueStyle) => list.map(([label, value]) => `
        <tr>
          <td style="padding:10px 16px 10px 0;border-top:1px solid #D9D1C5;color:#6E665C;white-space:nowrap;vertical-align:top">${escapeHtml(label)}</td>
          <td style="padding:10px 0;border-top:1px solid #D9D1C5;${valueStyle || ''}">${linkify(value)}</td>
        </tr>`).join('');

  const html = `
    <div style="font-family:Georgia,serif;color:#1C1A17;max-width:560px">
      ${meta.origin ? `<img src="${meta.origin}/assets/images/fsp-logo-email.png" width="240" height="36" alt="Fairmount Street Partners" style="display:block;border:0;width:240px;height:36px;margin:0 0 32px">` : ''}
      <p style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#9C7A55;margin:0 0 16px">New private tour request</p>
      <h1 style="font-weight:normal;font-size:28px;margin:0 0 4px">${escapeHtml(name)}</h1>
      <p style="font-family:Arial,sans-serif;font-size:14px;color:#6E665C;margin:0 0 20px">${escapeHtml(contactLine)}</p>
      <table role="presentation" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:0 0 20px">
        <tr>${actions.map(button).join('')}
        </tr>
      </table>
      <table style="font-family:Arial,sans-serif;font-size:14px;border-collapse:collapse;width:100%">${rows(details)}
      </table>
      <p style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#9C7A55;margin:32px 0 8px">Lead source</p>
      <table style="font-family:Arial,sans-serif;font-size:13px;border-collapse:collapse;width:100%">${rows(source, 'color:#6E665C')}
      </table>
      ${recordUrl ? `<p style="font-family:Arial,sans-serif;font-size:14px;margin:24px 0 0"><a href="${recordUrl}" style="color:#9C7A55">View contact in HubSpot</a></p>` : ''}
      <p style="font-family:Arial,sans-serif;font-size:12px;color:#6E665C;margin:24px 0 0">Reply to this email to respond to ${escapeHtml(lead.firstname)} directly.</p>
    </div>`;

  const payload = JSON.stringify({
    senderAddress: NOTIFY_FROM,
    recipients: { to: NOTIFY_TO.split(',').map((address) => ({ address: address.trim() })).filter((r) => r.address) },
    replyTo: [{ address: lead.email, displayName: name }],
    content: { subject: `New private tour request — ${name}`, plainText, html }
  });

  const date = new Date().toUTCString();
  const contentHash = crypto.createHash('sha256').update(payload, 'utf8').digest('base64');
  const stringToSign = `POST\n${url.pathname}${url.search}\n${date};${url.host};${contentHash}`;
  const signature = crypto.createHmac('sha256', Buffer.from(accesskey, 'base64')).update(stringToSign, 'utf8').digest('base64');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-ms-date': date,
      'x-ms-content-sha256': contentHash,
      Authorization: `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${signature}`
    },
    body: payload
  });
  if (res.status !== 202) throw await apiError('email', res);
}

function parseConnectionString(value) {
  const parts = {};
  for (const pair of String(value).split(';')) {
    const i = pair.indexOf('=');
    if (i > 0) parts[pair.slice(0, i).trim().toLowerCase()] = pair.slice(i + 1).trim();
  }
  if (!parts.endpoint || !parts.accesskey) throw new Error('ACS_CONNECTION_STRING is missing endpoint or accesskey');
  return { endpoint: parts.endpoint.replace(/\/+$/, ''), accesskey: parts.accesskey };
}

/* --- Helpers --------------------------------------------------------------- */

function tourDetails(lead) {
  return [
    ['Preferred date', formatDate(lead.preferred_date) || 'Not specified'],
    ['Working with an agent', lead.working_with_agent || 'Not specified'],
    ['Message', lead.message || '—']
  ];
}

// Submission time, referrer/campaign and site. Values are strings or
// { text, href } for links.
function sourceDetails(meta) {
  const { source } = meta;
  const list = [['Submitted', formatTimestamp(meta.submittedAt)]];
  list.push(['Found via', source.referrer
    ? { text: source.referrer.host, href: source.referrer.url }
    : 'Direct — typed URL, bookmark or app']);
  if (source.campaign) list.push(['Campaign', source.campaign]);
  if (source.landing) list.push(['Landing page', { text: source.landing.replace(/^https?:\/\//, ''), href: source.landing }]);
  list.push(['Submitted on', { text: SITE_DOMAIN.replace(/^https?:\/\//, ''), href: SITE_DOMAIN }]);
  return list;
}

// Where the visitor came from, as recorded by the browser on arrival. Only
// http(s) URLs are accepted; the landing page is listed only when it carries
// campaign parameters, since otherwise it's just the home page.
function leadSource(body) {
  const referrer = safeUrl(body.referrer);
  const landing = safeUrl(body.landingUrl);
  const params = landing ? landing.searchParams : new URLSearchParams();

  const utm = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']
    .map((key) => params.get(key))
    .filter(Boolean)
    .map((value) => value.slice(0, 80));
  if (params.has('gclid')) utm.push('Google Ads click');
  if (params.has('fbclid')) utm.push('Facebook/Instagram click');

  return {
    referrer: referrer ? { host: referrer.host.replace(/^www\./, ''), url: referrer.href } : null,
    campaign: utm.length ? utm.join(' · ') : null,
    landing: landing && utm.length ? landing.href : null
  };
}

function safeUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 1000) return null;
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) ? url : null;
  } catch (e) {
    return null;
  }
}

// Phone number in dialable form (+1XXXXXXXXXX for US numbers), or null
function dialable(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  if (/^\s*\+/.test(phone) && digits.length >= 8) return '+' + digits;
  return null;
}

function formatTimestamp(date) {
  return date.toLocaleString('en-US', {
    timeZone: TIME_ZONE, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
  });
}

// Table value → HTML: plain strings are escaped, { text, href } becomes a link
function linkify(value) {
  if (value && typeof value === 'object') {
    return `<a href="${escapeHtml(value.href)}" style="color:#9C7A55">${escapeHtml(value.text)}</a>`;
  }
  return escapeHtml(value).replace(/\n/g, '<br>');
}

// Table value → plain text
function textOf(value) {
  if (value && typeof value === 'object') return value.href;
  return value;
}

// The form's date picker sends YYYY-MM-DD; anything else is passed through as typed
function formatDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return value;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

// Public origin of this site, used for image URLs in the email. Taken from
// SITE_URL or the headers Azure sets — never from the request body, so a
// visitor can't point the email at another image host.
function siteOrigin(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/+$/, '');
  try {
    if (req.headers['x-ms-original-url']) return new URL(req.headers['x-ms-original-url']).origin;
  } catch (e) { /* fall through */ }
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return /^[a-z0-9.-]+(:\d+)?$/i.test(host) ? 'https://' + host : null;
}

// First x-forwarded-for entry, minus any port. HubSpot only needs it for
// analytics, so anything that isn't a plain IPv4 address is left out.
function clientIp(req) {
  const first = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = first.replace(/:\d+$/, '');
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip : undefined;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function json(status, body) {
  return { status, headers: { 'Content-Type': 'application/json' }, body };
}
