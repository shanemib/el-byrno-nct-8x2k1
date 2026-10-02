/**
 * NCT Appointment Alerts — Stripe payment Worker
 * ===============================================
 *
 * Single-file, dependency-free Cloudflare Worker. No npm install, no
 * wrangler build step needed — this file can be pasted directly into the
 * Cloudflare dashboard's Worker "Quick edit" editor and deployed as-is.
 * See SETUP.md "Paid tiers" for the full picture and deployment steps.
 *
 * Endpoints:
 *   POST /create-checkout-session
 *     Called by the website's signup form (docs/app.js) when someone picks
 *     a paid plan. Body (JSON): { email, plan, interval, centres,
 *     days_ahead, whatsapp_number }. Creates a Stripe Checkout Session
 *     (Managed Payments) and returns { url } for the browser to redirect to.
 *
 *   POST /webhook
 *     Called by Stripe itself when payment events happen. Verifies the
 *     request really came from Stripe (manual signature check — see
 *     verifyStripeSignature below), then creates/extends the subscriber row
 *     in Supabase via the same RPC functions defined in supabase_schema.sql.
 *
 * REQUIRED environment variables / secrets (set in the Cloudflare dashboard
 * under Settings -> Variables and Secrets — see SETUP.md for exact steps):
 *   STRIPE_SECRET_KEY          sk_live_... (SECRET — encrypt this one)
 *   STRIPE_WEBHOOK_SECRET      whsec_... (SECRET — encrypt this one, from
 *                              the webhook endpoint's own settings page)
 *   SUPABASE_URL               https://xxxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY  (SECRET — encrypt this one; bypasses RLS)
 *   PRICE_INDIVIDUAL           price_... (one-off, €2.99)
 *   PRICE_GARAGE_WEEK          price_... (recurring, weekly)
 *   PRICE_GARAGE_MONTH         price_... (recurring, monthly)
 *   PRICE_GARAGE_YEAR          price_... (recurring, yearly)
 *   SITE_URL                   https://nctsalerts.ie   (no trailing slash)
 *   ALLOWED_ORIGIN             https://nctsalerts.ie   (for CORS — the only
 *                              origin allowed to call /create-checkout-session)
 *
 * None of the three secret values above are ever written by Claude — they
 * must be typed directly into the Cloudflare dashboard by whoever owns the
 * Stripe/Supabase accounts. This file only ever reads them from `env`.
 */

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const JSON_HEADERS = { "Content-Type": "application/json" };

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const WHATSAPP_RE = /^\+[1-9]\d{6,14}$/;

/**
 * Flattens a nested JS object into Stripe's bracket-notation form encoding,
 * e.g. { line_items: [{ price: "x", quantity: 1 }] } becomes
 * line_items[0][price]=x&line_items[0][quantity]=1 — this is what Stripe's
 * REST API expects for application/x-www-form-urlencoded request bodies
 * (there's no JSON request body option without their SDK).
 */
function toStripeForm(obj, prefix = "") {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null || value === "") continue;
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    appendStripeFormValue(params, fullKey, value);
  }
  return params;
}

function appendStripeFormValue(params, key, value) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => appendStripeFormValue(params, `${key}[${i}]`, item));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined || v === null || v === "") continue;
      appendStripeFormValue(params, `${key}[${k}]`, v);
    }
  } else {
    params.append(key, String(value));
  }
}

async function stripeRequest(env, method, path, formBody) {
  const resp = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: formBody ? formBody.toString() : undefined,
  });
  const data = await resp.json();
  if (!resp.ok) {
    const message = data?.error?.message || `Stripe API error (${resp.status})`;
    throw new Error(message);
  }
  return data;
}

async function supabaseRpc(env, fnName, args) {
  const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Supabase RPC ${fnName} failed (${resp.status}): ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

// Stripe metadata values are capped at 500 chars each (50 keys max). A
// subscriber's chosen centres, JSON-encoded, could exceed that for someone
// who picks a lot of centres, so split across centres_0, centres_1, ... and
// reassemble on the webhook side. Comfortably covers every real NCT centre
// in the country even at ~500 chars per chunk.
const METADATA_CHUNK_SIZE = 450;

function chunkCentresMetadata(centres) {
  const encoded = JSON.stringify(centres);
  const chunks = {};
  for (let i = 0, n = 0; i < encoded.length; i += METADATA_CHUNK_SIZE, n++) {
    chunks[`centres_${n}`] = encoded.slice(i, i + METADATA_CHUNK_SIZE);
  }
  return chunks;
}

function unchunkCentresMetadata(metadata) {
  const parts = [];
  for (let n = 0; metadata[`centres_${n}`] !== undefined; n++) {
    parts.push(metadata[`centres_${n}`]);
  }
  if (parts.length === 0) return [];
  try {
    return JSON.parse(parts.join(""));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// POST /create-checkout-session
// ---------------------------------------------------------------------------

const GARAGE_PRICE_ENV_BY_INTERVAL = {
  week: "PRICE_GARAGE_WEEK",
  month: "PRICE_GARAGE_MONTH",
  year: "PRICE_GARAGE_YEAR",
};

async function handleCreateCheckoutSession(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders(env));
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const plan = body.plan;
  const interval = body.interval;
  const centres = Array.isArray(body.centres) ? body.centres.filter((c) => typeof c === "string" && c) : [];
  const daysAhead = Number(body.days_ahead);
  const whatsappNumber = typeof body.whatsapp_number === "string" && body.whatsapp_number.trim()
    ? body.whatsapp_number.trim()
    : null;

  if (!EMAIL_RE.test(email)) {
    return jsonResponse({ error: "Please enter a valid email address" }, 400, corsHeaders(env));
  }
  if (centres.length === 0) {
    return jsonResponse({ error: "Please choose at least one test centre" }, 400, corsHeaders(env));
  }
  if (!Number.isInteger(daysAhead) || daysAhead < 1 || daysAhead > 90) {
    return jsonResponse({ error: "days_ahead must be between 1 and 90" }, 400, corsHeaders(env));
  }
  if (whatsappNumber && !WHATSAPP_RE.test(whatsappNumber)) {
    return jsonResponse(
      { error: "WhatsApp number must be in international format, e.g. +353871234567" },
      400,
      corsHeaders(env)
    );
  }
  if (plan !== "individual" && plan !== "garage") {
    return jsonResponse({ error: "plan must be 'individual' or 'garage'" }, 400, corsHeaders(env));
  }

  let priceId;
  let mode;
  if (plan === "individual") {
    priceId = env.PRICE_INDIVIDUAL;
    mode = "payment";
  } else {
    const envKey = GARAGE_PRICE_ENV_BY_INTERVAL[interval];
    if (!envKey) {
      return jsonResponse({ error: "interval must be 'week', 'month', or 'year'" }, 400, corsHeaders(env));
    }
    priceId = env[envKey];
    mode = "subscription";
  }
  if (!priceId) {
    return jsonResponse({ error: "Server is missing a required price ID — check Worker configuration" }, 500, corsHeaders(env));
  }

  const metadata = {
    plan,
    days_ahead: String(daysAhead),
    whatsapp_number: whatsappNumber || "",
    ...chunkCentresMetadata(centres),
  };

  const sessionParams = {
    mode,
    customer_email: email,
    success_url: `${env.SITE_URL}/payment-success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${env.SITE_URL}/payment-cancelled.html`,
    line_items: [{ price: priceId, quantity: 1 }],
    metadata,
    managed_payments: { enabled: true },
  };
  // Also attach metadata to the subscription itself for garage plans, so
  // it's visible on the Subscription object in the Stripe dashboard too
  // (not required for the webhook logic below, which keys off customer id).
  if (mode === "subscription") {
    sessionParams.subscription_data = { metadata };
  }

  let session;
  try {
    session = await stripeRequest(env, "POST", "checkout/sessions", toStripeForm(sessionParams));
  } catch (err) {
    return jsonResponse({ error: err.message || "Could not start checkout" }, 502, corsHeaders(env));
  }

  return jsonResponse({ url: session.url }, 200, corsHeaders(env));
}

// ---------------------------------------------------------------------------
// POST /webhook
// ---------------------------------------------------------------------------

/**
 * Manual Stripe webhook signature verification (no SDK available without a
 * bundler). Mirrors what stripe.webhooks.constructEvent does:
 *   1. Parse the Stripe-Signature header: "t=<timestamp>,v1=<hex>[,v1=<hex>...]"
 *   2. Compute HMAC-SHA256 over "<timestamp>.<rawBody>" using the webhook's
 *      signing secret.
 *   3. Check the computed signature matches one of the v1 values.
 *   4. Reject if the timestamp is too old (replay-attack protection).
 */
async function verifyStripeSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader) return false;

  const parts = Object.fromEntries(
    signatureHeader.split(",").map((pair) => {
      const [k, v] = pair.split("=");
      return [k, v];
    })
  );
  const timestamp = parts.t;
  const expectedSignatures = signatureHeader
    .split(",")
    .filter((pair) => pair.startsWith("v1="))
    .map((pair) => pair.slice(3));

  if (!timestamp || expectedSignatures.length === 0) return false;

  // Reject anything older than 5 minutes.
  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds) || Math.abs(Date.now() / 1000 - timestampSeconds) > 300) {
    return false;
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${rawBody}`));
  const computedHex = [...new Uint8Array(signatureBuffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

  return expectedSignatures.some((expected) => timingSafeEqual(expected, computedHex));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function handleCheckoutSessionCompleted(env, session) {
  const metadata = session.metadata || {};
  const plan = metadata.plan;
  const email = (session.customer_details?.email || session.customer_email || "").toLowerCase();
  const daysAhead = Number(metadata.days_ahead) || 28;
  const whatsappNumber = metadata.whatsapp_number || null;
  const centres = unchunkCentresMetadata(metadata);

  if (!email || centres.length === 0) {
    console.log(`[webhook] checkout.session.completed ${session.id}: missing email or centres, skipping`);
    return;
  }

  if (plan === "individual") {
    const expiresAt = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString();
    const externalCustomerId = session.customer || session.id;
    await supabaseRpc(env, "create_individual_subscriber", {
      p_email: email,
      p_centres: centres,
      p_days_ahead: daysAhead,
      p_whatsapp_number: whatsappNumber,
      p_external_customer_id: externalCustomerId,
      p_expires_at: expiresAt,
    });
    console.log(`[webhook] created individual subscriber for ${email}, expires ${expiresAt}`);
  } else if (plan === "garage") {
    if (!session.subscription) {
      console.log(`[webhook] checkout.session.completed ${session.id}: garage plan with no subscription id, skipping`);
      return;
    }
    const subscription = await stripeRequest(env, "GET", `subscriptions/${session.subscription}`);
    const expiresAt = new Date(subscription.current_period_end * 1000).toISOString();
    await supabaseRpc(env, "create_garage_watch", {
      p_email: email,
      p_centres: centres,
      p_days_ahead: daysAhead,
      p_whatsapp_number: whatsappNumber,
      p_external_customer_id: session.customer,
      p_expires_at: expiresAt,
    });
    console.log(`[webhook] created garage watch for ${email} (customer ${session.customer}), expires ${expiresAt}`);
  } else {
    console.log(`[webhook] checkout.session.completed ${session.id}: unrecognized plan '${plan}', skipping`);
  }
}

async function handleInvoicePaid(env, invoice) {
  // Fires for both the very first invoice on a new subscription and every
  // renewal after that. Deliberately order-independent with
  // checkout.session.completed above: update_garage_subscription_expiry only
  // updates rows that already exist (by external_customer_id), so if this
  // event arrives first it's a harmless no-op, and the row gets its correct
  // expiry directly from checkout.session.completed a moment later.
  if (!invoice.subscription || !invoice.customer) {
    return; // one-off (individual) invoices aren't subscriptions — nothing to extend
  }

  const subscription = await stripeRequest(env, "GET", `subscriptions/${invoice.subscription}`);
  const expiresAt = new Date(subscription.current_period_end * 1000).toISOString();
  const affected = await supabaseRpc(env, "update_garage_subscription_expiry", {
    p_external_customer_id: invoice.customer,
    p_new_expires_at: expiresAt,
  });
  console.log(`[webhook] invoice.paid for customer ${invoice.customer}: extended ${affected} row(s) to ${expiresAt}`);
}

async function handleWebhook(request, env) {
  const rawBody = await request.text();
  const signature = request.headers.get("Stripe-Signature");

  const valid = await verifyStripeSignature(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) {
    return jsonResponse({ error: "Invalid signature" }, 400);
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutSessionCompleted(env, event.data.object);
        break;
      case "invoice.paid":
        await handleInvoicePaid(env, event.data.object);
        break;
      default:
        // Nothing else needs handling — see stripe-worker.js module comment
        // and SETUP.md for why e.g. customer.subscription.deleted is
        // deliberately left alone (access just lapses once plan_expires_at
        // passes, no special cancellation handling needed).
        break;
    }
  } catch (err) {
    // Log and still return 200 would hide real failures from Stripe's retry
    // mechanism — return 500 so Stripe retries this event automatically.
    console.log(`[webhook] error handling ${event.type}: ${err.message}`);
    return jsonResponse({ error: "Internal error processing webhook" }, 500);
  }

  return jsonResponse({ received: true }, 200);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    if (url.pathname === "/create-checkout-session" && request.method === "POST") {
      try {
        return await handleCreateCheckoutSession(request, env);
      } catch (err) {
        console.log(`[create-checkout-session] unexpected error: ${err.message}`);
        return jsonResponse({ error: "Internal error" }, 500, corsHeaders(env));
      }
    }

    if (url.pathname === "/webhook" && request.method === "POST") {
      return handleWebhook(request, env);
    }

    if (url.pathname === "/" || url.pathname === "") {
      return new Response("NCT Appointment Alerts — Stripe Worker is running.", { status: 200 });
    }

    return jsonResponse({ error: "Not found" }, 404, corsHeaders(env));
  },
};
