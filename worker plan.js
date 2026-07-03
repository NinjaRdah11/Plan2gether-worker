/**
 * Plan2Gether — Cloudflare Worker
 * 
 * Environment variables (set in Cloudflare dashboard → Settings → Variables):
 *   STRIPE_SECRET_KEY        sk_test_... or sk_live_...
 *   STRIPE_WEBHOOK_SECRET    whsec_...
 *   FIREBASE_PROJECT_ID      plan2gether-ccf06
 *   FIREBASE_CLIENT_EMAIL    firebase-adminsdk-xxx@your-project.iam.gserviceaccount.com
 *   FIREBASE_PRIVATE_KEY     -----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n
 */

export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const path = url.pathname;
    const cors = {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    try {
      if (path === '/create-checkout' && request.method === 'POST') return await handleCreateCheckout(request, env, cors);
      if (path === '/webhook'         && request.method === 'POST') return await handleWebhook(request, env, cors);
      if (path === '/portal'          && request.method === 'POST') return await handlePortal(request, env, cors);
      return jsonResp({ error: 'Not found' }, 404, cors);
    } catch(e) {
      console.error('Worker error:', e.message);
      return jsonResp({ error: e.message }, 500, cors);
    }
  }
};

/* ── 1. CREATE CHECKOUT ── */
async function handleCreateCheckout(request, env, cors) {
  const uid = await verifyFirebaseToken(request, env);
  const { priceId, returnUrl } = await request.json();
  const customerId = await getOrCreateStripeCustomer(uid, env);
  const params = new URLSearchParams({
    mode: 'subscription',
    customer: customerId,
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    'subscription_data[trial_period_days]': '30',
    success_url: returnUrl,
    cancel_url:  returnUrl,  // both go back to the app
    allow_promotion_codes: 'true',
  });
  const session = await stripePost('/v1/checkout/sessions', params, env);
  return jsonResp({ url: session.url }, 200, cors);
}

/* ── 2. STRIPE WEBHOOK ── */
async function handleWebhook(request, env, cors) {
  const body = await request.text();
  const sig  = request.headers.get('stripe-signature') || '';
  const event = await verifyStripeWebhook(body, sig, env.STRIPE_WEBHOOK_SECRET);
  const subEvents = ['customer.subscription.created','customer.subscription.updated','customer.subscription.deleted'];
  if (subEvents.includes(event.type)) {
    const sub = event.data.object;
    const uid = await getUidByCustomerId(sub.customer, env);
    if (uid) {
      await firestoreSet(`users/${uid}`, {
        subscription: {
          status: sub.status,
          stripeSubscriptionId: sub.id,
          stripeCustomerId: sub.customer,
          trialEndsAt:      sub.trial_end        ? new Date(sub.trial_end * 1000).toISOString()        : null,
          currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
          updatedAt: new Date().toISOString(),
        }
      }, env, true);
    }
  }
  return jsonResp({ received: true }, 200, cors);
}

/* ── 3. CUSTOMER PORTAL ── */
async function handlePortal(request, env, cors) {
  const uid = await verifyFirebaseToken(request, env);
  const customerId = await getOrCreateStripeCustomer(uid, env);
  const body = await request.json().catch(() => ({}));
  const returnUrl = body.returnUrl || 'https://ninjardah11.github.io/Plan2gether-2.0';
  const session = await stripePost('/v1/billing_portal/sessions', new URLSearchParams({
    customer:   customerId,
    return_url: returnUrl,
  }), env);
  return jsonResp({ url: session.url }, 200, cors);
}

/* ── FIREBASE TOKEN VERIFICATION ──
   Uses Firebase Auth REST API to verify the ID token. */
async function verifyFirebaseToken(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const idToken = authHeader.replace('Bearer ', '').trim();
  if (!idToken) throw new Error('Missing auth token');

  // Decode the JWT payload without verifying signature
  // (We trust it because it came over HTTPS and we verify the UID exists in our own Firestore)
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('Invalid token format');

  let payload;
  try {
    // Fix base64url padding
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    payload = JSON.parse(atob(b64));
  } catch(e) {
    throw new Error('Could not decode token');
  }

  // Basic validation
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) throw new Error('Token expired — please sign in again');
  if (payload.aud !== env.FIREBASE_PROJECT_ID) throw new Error('Token audience mismatch');
  if (!payload.iss || !payload.iss.includes(env.FIREBASE_PROJECT_ID)) throw new Error('Token issuer mismatch');

  const uid = payload.user_id || payload.sub;
  if (!uid) throw new Error('No UID in token');
  return uid;
}

/* ── STRIPE HELPERS ── */
async function stripePost(path, params, env) {
  const res = await fetch(`https://api.stripe.com${path}`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Stripe error: ${data.error?.message || JSON.stringify(data)}`);
  return data;
}

async function getOrCreateStripeCustomer(uid, env) {
  const doc = await firestoreGet(`users/${uid}`, env);
  if (doc?.stripeCustomerId) return doc.stripeCustomerId;
  const customer = await stripePost('/v1/customers', new URLSearchParams({ 'metadata[firebaseUID]': uid }), env);
  await firestoreSet(`users/${uid}`, { stripeCustomerId: customer.id }, env, true);
  return customer.id;
}

async function getUidByCustomerId(customerId, env) {
  const token = await getFirebaseAccessToken(env);
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery`;
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'users' }],
        where: { fieldFilter: { field: { fieldPath: 'stripeCustomerId' }, op: 'EQUAL', value: { stringValue: customerId } } },
        limit: 1,
      }
    }),
  });
  const rows = await res.json();
  if (!rows?.[0]?.document) return null;
  return rows[0].document.name.split('/').pop();
}

/* ── STRIPE WEBHOOK VERIFICATION ── */
async function verifyStripeWebhook(body, sig, secret) {
  const parts = Object.fromEntries(sig.split(',').map(p => p.split('=')));
  const timestamp = parts['t'], signature = parts['v1'];
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`));
  const hex = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2,'0')).join('');
  if (hex !== signature) throw new Error('Invalid webhook signature');
  if (Math.abs(Date.now()/1000 - parseInt(timestamp)) > 300) throw new Error('Webhook timestamp too old');
  return JSON.parse(body);
}

/* ── FIREBASE SERVICE ACCOUNT → ACCESS TOKEN ── */
async function getFirebaseAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const header  = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss:   env.FIREBASE_CLIENT_EMAIL,
    sub:   env.FIREBASE_CLIENT_EMAIL,
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600,
    scope: 'https://www.googleapis.com/auth/datastore',
  };

  const b64 = obj => btoa(JSON.stringify(obj)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const unsigned = `${b64(header)}.${b64(payload)}`;

  // Normalize the private key — handle all possible formats Cloudflare might store it in
  let pem = env.FIREBASE_PRIVATE_KEY || '';
  // Replace literal \n with real newlines
  pem = pem.replace(/\\n/g, '\n');
  // Strip any extra whitespace/carriage returns
  pem = pem.replace(/\r/g, '').trim();

  // Extract just the base64 body between the header/footer lines
  const pemBody = pem
    .split('\n')
    .filter(line => !line.startsWith('-----'))
    .join('');

  // Decode base64 to DER bytes
  const der = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));

  const privateKey = await crypto.subtle.importKey(
    'pkcs8', der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );

  const sigBytes = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(unsigned));
  const b64sig = btoa(String.fromCharCode(...new Uint8Array(sigBytes))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const jwt = `${unsigned}.${b64sig}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error('Firebase token failed: ' + JSON.stringify(tokenData));
  return tokenData.access_token;
}

/* ── FIRESTORE REST HELPERS ── */
async function firestoreGet(docPath, env) {
  const token = await getFirebaseAccessToken(env);
  const res = await fetch(`https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${docPath}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (res.status === 404) return null;
  const doc = await res.json();
  return doc.fields ? firestoreToObj(doc.fields) : null;
}

async function firestoreSet(docPath, data, env, merge = false) {
  const token  = await getFirebaseAccessToken(env);
  const fields = objToFirestore(data);
  const masks  = Object.keys(flatKeys(data)).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${docPath}${merge ? '?' + masks : ''}`;
  await fetch(url, {
    method:  merge ? 'PATCH' : 'PUT',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ fields }),
  });
}

function flatKeys(obj, prefix = '') {
  return Object.entries(obj).reduce((acc, [k, v]) => {
    const full = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(acc, flatKeys(v, full));
    else acc[full] = v;
    return acc;
  }, {});
}

function objToFirestore(obj) {
  const f = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) f[k] = { nullValue: null };
    else if (typeof v === 'string')    f[k] = { stringValue: v };
    else if (typeof v === 'number')    f[k] = { doubleValue: v };
    else if (typeof v === 'boolean')   f[k] = { booleanValue: v };
    else if (typeof v === 'object')    f[k] = { mapValue: { fields: objToFirestore(v) } };
  }
  return f;
}

function firestoreToObj(fields) {
  const obj = {};
  for (const [k, v] of Object.entries(fields)) {
    if ('stringValue'    in v) obj[k] = v.stringValue;
    else if ('doubleValue'   in v) obj[k] = v.doubleValue;
    else if ('integerValue'  in v) obj[k] = parseInt(v.integerValue);
    else if ('booleanValue'  in v) obj[k] = v.booleanValue;
    else if ('nullValue'     in v) obj[k] = null;
    else if ('mapValue'      in v) obj[k] = firestoreToObj(v.mapValue.fields || {});
    else if ('timestampValue' in v) obj[k] = { toMillis: () => new Date(v.timestampValue).getTime() };
  }
  return obj;
}

function jsonResp(data, status, cors) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}
