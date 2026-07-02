/**
 * Plan2Gether — Cloudflare Worker
 * 
 * Handles 3 endpoints:
 *   POST /create-checkout  → creates a Stripe Checkout Session (with 30-day trial)
 *   POST /webhook          → handles Stripe events → writes to Firestore
 *   POST /portal           → creates a Stripe Customer Portal session
 * 
 * Environment variables to set in Cloudflare dashboard:
 *   STRIPE_SECRET_KEY        → sk_live_... (or sk_test_... for testing)
 *   STRIPE_WEBHOOK_SECRET    → whsec_...
 *   FIREBASE_PROJECT_ID      → plan2gether-ccf06
 *   FIREBASE_CLIENT_EMAIL    → from your Firebase service account JSON
 *   FIREBASE_PRIVATE_KEY     → from your Firebase service account JSON (the full -----BEGIN... key)
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers — allow your app's origin in production
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    try {
      if (path === '/create-checkout' && request.method === 'POST') {
        return await handleCreateCheckout(request, env, cors);
      }
      if (path === '/webhook' && request.method === 'POST') {
        return await handleWebhook(request, env, cors);
      }
      if (path === '/portal' && request.method === 'POST') {
        return await handlePortal(request, env, cors);
      }
      return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { ...cors, 'Content-Type': 'application/json' } });
    } catch (e) {
      console.error(e);
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
    }
  }
};

/* ─────────────────────────────────────────────
   1. CREATE CHECKOUT SESSION
   ───────────────────────────────────────────── */
async function handleCreateCheckout(request, env, cors) {
  const uid = await verifyFirebaseToken(request, env);
  const { priceId, returnUrl } = await request.json();

  // Get or create Stripe customer tied to this Firebase UID
  const customerId = await getOrCreateStripeCustomer(uid, env);

  // Create Checkout Session with 30-day trial
  const params = new URLSearchParams({
    'mode': 'subscription',
    'customer': customerId,
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    'subscription_data[trial_period_days]': '30',
    'success_url': returnUrl,
    'cancel_url': returnUrl,
    'allow_promotion_codes': 'true',
    'customer_update[address]': 'auto',
    'billing_address_collection': 'auto',
  });

  const session = await stripePost('/v1/checkout/sessions', params, env);
  return json({ url: session.url }, cors);
}

/* ─────────────────────────────────────────────
   2. STRIPE WEBHOOK
   Listens for subscription events and updates
   Firestore so the app knows who is subscribed.
   ───────────────────────────────────────────── */
async function handleWebhook(request, env, cors) {
  const body = await request.text();
  const sig  = request.headers.get('stripe-signature');

  // Verify the webhook really came from Stripe
  const event = await verifyStripeWebhook(body, sig, env.STRIPE_WEBHOOK_SECRET);

  const subEvents = [
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted',
  ];

  if (subEvents.includes(event.type)) {
    const sub = event.data.object;
    const customerId = sub.customer;

    // Find the Firebase UID mapped to this Stripe customer
    const uid = await getUidByCustomerId(customerId, env);
    if (!uid) return json({ received: true }, cors);

    // Build subscription payload for Firestore
    const status = sub.status; // 'trialing' | 'active' | 'canceled' | 'past_due' etc.
    const trialEnd = sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null;
    const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;

    await firestoreSet(`users/${uid}`, {
      subscription: {
        status,
        stripeSubscriptionId: sub.id,
        stripeCustomerId: customerId,
        trialEndsAt: trialEnd,
        currentPeriodEnd: periodEnd,
        updatedAt: new Date().toISOString(),
      }
    }, env, true /* merge */);
  }

  return json({ received: true }, cors);
}

/* ─────────────────────────────────────────────
   3. CUSTOMER PORTAL
   Lets users manage / cancel their subscription
   ───────────────────────────────────────────── */
async function handlePortal(request, env, cors) {
  const uid = await verifyFirebaseToken(request, env);
  const customerId = await getOrCreateStripeCustomer(uid, env);
  const { returnUrl } = await request.json().catch(() => ({ returnUrl: 'https://plan2gether.app' }));

  const session = await stripePost('/v1/billing_portal/sessions', new URLSearchParams({
    customer: customerId,
    return_url: returnUrl || 'https://plan2gether.app',
  }), env);

  return json({ url: session.url }, cors);
}

/* ─────────────────────────────────────────────
   STRIPE HELPERS
   ───────────────────────────────────────────── */
async function stripePost(path, params, env) {
  const res = await fetch(`https://api.stripe.com${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Stripe error: ${data.error?.message || JSON.stringify(data)}`);
  return data;
}

async function stripeGet(path, env) {
  const res = await fetch(`https://api.stripe.com${path}`, {
    headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Stripe error: ${data.error?.message}`);
  return data;
}

async function getOrCreateStripeCustomer(uid, env) {
  // Check if we already stored a customer ID in Firestore
  const doc = await firestoreGet(`users/${uid}`, env);
  if (doc && doc.stripeCustomerId) return doc.stripeCustomerId;

  // Create a new Stripe customer tagged with the Firebase UID
  const customer = await stripePost('/v1/customers', new URLSearchParams({
    'metadata[firebaseUID]': uid,
  }), env);

  // Persist customer ID to Firestore
  await firestoreSet(`users/${uid}`, { stripeCustomerId: customer.id }, env, true);
  return customer.id;
}

async function getUidByCustomerId(customerId, env) {
  // We store stripeCustomerId on the user doc — query Firestore for it
  const token = await getFirebaseAccessToken(env);
  const projectId = env.FIREBASE_PROJECT_ID;
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`;
  const body = JSON.stringify({
    structuredQuery: {
      from: [{ collectionId: 'users' }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'stripeCustomerId' },
          op: 'EQUAL',
          value: { stringValue: customerId },
        }
      },
      limit: 1,
    }
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body,
  });
  const rows = await res.json();
  if (!rows || !rows[0] || !rows[0].document) return null;
  // Document name is like: projects/.../users/{uid}
  const name = rows[0].document.name;
  return name.split('/').pop();
}

/* ─────────────────────────────────────────────
   STRIPE WEBHOOK VERIFICATION
   Uses the Web Crypto API (available in Workers)
   ───────────────────────────────────────────── */
async function verifyStripeWebhook(body, sig, secret) {
  const parts = sig.split(',').reduce((acc, p) => {
    const [k, v] = p.split('=');
    acc[k] = v;
    return acc;
  }, {});
  const timestamp = parts['t'];
  const signature = parts['v1'];
  const signed = `${timestamp}.${body}`;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signed));
  const hex = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('');
  if (hex !== signature) throw new Error('Invalid webhook signature');
  // Reject events older than 5 minutes
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > 300) throw new Error('Webhook timestamp too old');
  return JSON.parse(body);
}

/* ─────────────────────────────────────────────
   FIREBASE AUTH TOKEN VERIFICATION
   Verifies the Firebase ID token sent from the app
   ───────────────────────────────────────────── */
async function verifyFirebaseToken(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const idToken = authHeader.replace('Bearer ', '').trim();
  if (!idToken) throw new Error('Missing auth token');

  // Fetch Firebase public keys
  const keysRes = await fetch('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com');
  const keys = await keysRes.json();

  // Decode JWT header to find which key to use
  const [headerB64, payloadB64, sigB64] = idToken.split('.');
  const header = JSON.parse(atob(headerB64));
  const payload = JSON.parse(atob(payloadB64));

  // Basic payload validation
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) throw new Error('Token expired');
  if (payload.aud !== env.FIREBASE_PROJECT_ID) throw new Error('Token audience mismatch');
  if (payload.iss !== `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`) throw new Error('Token issuer mismatch');

  // Verify signature with the correct public key
  const certPem = keys[header.kid];
  if (!certPem) throw new Error('Unknown key ID');
  const certDer = pemToDer(certPem);
  const publicKey = await crypto.subtle.importKey(
    'spki', certDer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
  );
  const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = base64UrlDecode(sigB64);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, signature, signedData);
  if (!valid) throw new Error('Invalid token signature');

  return payload.user_id || payload.sub;
}

function pemToDer(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  return base64UrlDecode(b64);
}
function base64UrlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const binary = atob(str);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

/* ─────────────────────────────────────────────
   FIRESTORE REST API HELPERS
   ───────────────────────────────────────────── */
async function getFirebaseAccessToken(env) {
  // Use a service account to get an access token via JWT
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: env.FIREBASE_CLIENT_EMAIL,
    sub: env.FIREBASE_CLIENT_EMAIL,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/datastore',
  };
  const b64Header  = btoa(JSON.stringify(header)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const b64Payload = btoa(JSON.stringify(payload)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const unsigned   = `${b64Header}.${b64Payload}`;

  // Import RSA private key
  const pkcs8 = pemToDer(env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'));
  const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const b64Sig = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const jwt = `${unsigned}.${b64Sig}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error('Could not get Firebase access token: ' + JSON.stringify(tokenData));
  return tokenData.access_token;
}

async function firestoreGet(docPath, env) {
  const token = await getFirebaseAccessToken(env);
  const projectId = env.FIREBASE_PROJECT_ID;
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${docPath}`;
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
  if (res.status === 404) return null;
  const doc = await res.json();
  if (!doc.fields) return null;
  return firestoreToObject(doc.fields);
}

async function firestoreSet(docPath, data, env, merge = false) {
  const token = await getFirebaseAccessToken(env);
  const projectId = env.FIREBASE_PROJECT_ID;
  const fields = objectToFirestore(data);
  const url = merge
    ? `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${docPath}?updateMask.fieldPaths=${Object.keys(flattenKeys(data)).join('&updateMask.fieldPaths=')}`
    : `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${docPath}`;
  await fetch(url, {
    method: merge ? 'PATCH' : 'PUT',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
}

function flattenKeys(obj, prefix = '') {
  return Object.keys(obj).reduce((acc, k) => {
    const full = prefix ? `${prefix}.${k}` : k;
    if (obj[k] !== null && typeof obj[k] === 'object' && !Array.isArray(obj[k])) {
      Object.assign(acc, flattenKeys(obj[k], full));
    } else {
      acc[full] = obj[k];
    }
    return acc;
  }, {});
}

function objectToFirestore(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) { fields[k] = { nullValue: null }; }
    else if (typeof v === 'string')  { fields[k] = { stringValue: v }; }
    else if (typeof v === 'number')  { fields[k] = { doubleValue: v }; }
    else if (typeof v === 'boolean') { fields[k] = { booleanValue: v }; }
    else if (typeof v === 'object')  { fields[k] = { mapValue: { fields: objectToFirestore(v) } }; }
  }
  return fields;
}

function firestoreToObject(fields) {
  const obj = {};
  for (const [k, v] of Object.entries(fields)) {
    if ('stringValue'  in v) obj[k] = v.stringValue;
    else if ('doubleValue'  in v) obj[k] = v.doubleValue;
    else if ('integerValue' in v) obj[k] = parseInt(v.integerValue);
    else if ('booleanValue' in v) obj[k] = v.booleanValue;
    else if ('nullValue'    in v) obj[k] = null;
    else if ('mapValue'     in v) obj[k] = firestoreToObject(v.mapValue.fields || {});
    else if ('timestampValue' in v) obj[k] = { toMillis: () => new Date(v.timestampValue).getTime() };
  }
  return obj;
}

function json(data, cors) {
  return new Response(JSON.stringify(data), {
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}
