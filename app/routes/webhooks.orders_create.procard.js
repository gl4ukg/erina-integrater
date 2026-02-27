import { authenticate } from "../shopify.server";
import crypto from "crypto";

const API_VERSION = "2025-01";

/* ---------------- HELPERS ---------------- */

function normalizeAmount(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "0";
  return n.toString();
}

function makeRequestSignature({
  merchant_id,
  order_id,
  amount,
  currency_iso,
  description,
}) {
  const secret = process.env.PROCARD_SECRET;
  if (!secret) throw new Error("Missing PROCARD_SECRET");

  const amt = normalizeAmount(amount);
  const toSign = `${merchant_id};${order_id};${amt};${currency_iso};${description}`;

  return crypto
    .createHmac("sha512", secret)
    .update(toSign, "utf8")
    .digest("hex");
}

function getOrderTotal(payload) {
  const candidates = [
    payload?.current_total_price,
    payload?.total_price,
    payload?.current_total_price_set?.shop_money?.amount,
    payload?.total_price_set?.shop_money?.amount,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function isManualPayment(payload) {
  const names = (payload?.payment_gateway_names || []).map((x) =>
    String(x || "").toLowerCase(),
  );
  return names.includes("pay by card (email)") || names.includes("manual");
}

/* ---------------- SHOPIFY ADMIN TOKEN (CLIENT CREDENTIALS) ---------------- */

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAdminAccessToken() {
  const shop = process.env.SHOPIFY_STORE_DOMAIN;
  const clientId = process.env.SHOPIFY_API_KEY;
  const clientSecret = process.env.SHOPIFY_API_SECRET;
  const scopes = process.env.SHOPIFY_ADMIN_SCOPES;

  if (!shop || !clientId || !clientSecret || !scopes) {
    throw new Error(
      "Missing SHOPIFY_STORE_DOMAIN / SHOPIFY_API_KEY / SHOPIFY_API_SECRET / SHOPIFY_ADMIN_SCOPES",
    );
  }

  // Cache 23h
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
      scope: scopes,
    }),
  });

  const data = await response.json().catch(() => null);

  if (!response.ok || !data?.access_token) {
    console.error("Token generation failed:", {
      status: response.status,
      data,
    });
    throw new Error("Failed to generate admin access token");
  }

  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + 23 * 60 * 60 * 1000;

  console.log("Generated new Admin API token");
  return cachedToken;
}

async function shopifyRest(path, { method = "GET", body } = {}) {
  const shop = process.env.SHOPIFY_STORE_DOMAIN;
  const token = await getAdminAccessToken();

  const res = await fetch(`https://${shop}/admin/api/${API_VERSION}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  if (!res.ok) {
    console.error("Shopify REST error", {
      path,
      status: res.status,
      text,
      json,
    });
    throw new Error(`Shopify REST failed: ${res.status}`);
  }

  return json;
}

/* ---------------- UPDATE ORDER (TAGS + NOTE ATTRIBUTES) ---------------- */

async function updateOrder(orderIdNumeric, paymentUrl) {
  const current = await shopifyRest(`/orders/${orderIdNumeric}.json`);
  const order = current?.order;

  const existing = Array.isArray(order?.note_attributes)
    ? order.note_attributes
    : [];
  const filtered = existing.filter((a) => a?.name !== "procard_payment_url");

  const note_attributes = [
    ...filtered,
    { name: "procard_payment_url", value: paymentUrl },
  ];

  const tags = String(order?.tags || "");
  const nextTags = Array.from(
    new Set(
      tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
        .concat(["procard_link_sent"]),
    ),
  ).join(", ");

  await shopifyRest(`/orders/${orderIdNumeric}.json`, {
    method: "PUT",
    body: { order: { id: orderIdNumeric, tags: nextTags, note_attributes } },
  });

  console.log("Order updated with tag + note attribute");
}

/* ---------------- EMAIL (RESEND) ---------------- */

async function sendPaymentEmail(toEmail, paymentUrl, orderId) {
  const key = process.env.RE_SEND_API_KEY;
  const from = process.env.RESEND_EMAIL_FROM;
  //var updated

  if (!key || !from)
    throw new Error("Missing RE_SEND_API_KEY / RESEND_EMAIL_FROM");
  if (!toEmail) {
    console.warn("No customer email on order; skipping Resend email");
    return;
  }

  const subject = `Erina Home – Payment link for order #${orderId}`;
  const html = `
    <div style="font-family: Inter, Arial, sans-serif; line-height: 1.5;">
      <p>Hello,</p>
      <p>Thanks for your order at <strong>Erina Home</strong>.</p>
      <p>To complete your payment, please use this link:</p>
      <p style="margin: 16px 0;">
        <a href="${paymentUrl}" style="display:inline-block;padding:10px 14px;text-decoration:none;border-radius:8px;background:#13293D;color:#fff;">
          Pay now
        </a>
      </p>
      <p>Order: <strong>#${orderId}</strong></p>
      <p>If you have any questions, reply to this email.</p>
      <p>Best regards,<br/>Erina Home</p>
    </div>
  `;

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      from,
      to: toEmail,
      subject,
      html,
    }),
  });

  const data = await r.json().catch(() => null);

  if (!r.ok) {
    console.error("Resend error:", { status: r.status, data });
    throw new Error(`Resend failed: ${r.status}`);
  }

  console.log("Resend email sent:", data?.id || "ok");
}

/* ---------------- MAIN ACTION ---------------- */

export const action = async ({ request }) => {
  const { topic, payload } = await authenticate.webhook(request);
  console.log("WEBHOOK HIT:", topic);

  if (topic !== "ORDERS_CREATE") return new Response(null, { status: 200 });

  if (!isManualPayment(payload)) {
    console.log("Not manual payment → skip");
    return new Response(null, { status: 200 });
  }

  try {
    const dispatcherUrl = process.env.PROCARD_DISPATCHER_URL;
    const merchant_id = process.env.PROCARD_MERCHANT_ID;

    if (!dispatcherUrl || !merchant_id) {
      throw new Error("Missing PROCARD_DISPATCHER_URL / PROCARD_MERCHANT_ID");
    }

    const orderRef = String(payload?.id || "");
    const amount = getOrderTotal(payload);
    const description = `Erina Home ${orderRef}`;

    const reqBody = {
      operation: "Purchase",
      merchant_id,
      order_id: orderRef,
      amount: Number(normalizeAmount(amount)),
      currency_iso: "EUR",
      description,
      approve_url: process.env.PROCARD_APPROVE_URL,
      decline_url: process.env.PROCARD_DECLINE_URL,
      cancel_url: process.env.PROCARD_CANCEL_URL,
      callback_url: process.env.PROCARD_CALLBACK_URL,
      redirect: 0,
      email: payload?.email || "",
    };

    reqBody.signature = makeRequestSignature({
      merchant_id: reqBody.merchant_id,
      order_id: reqBody.order_id,
      amount: reqBody.amount,
      currency_iso: reqBody.currency_iso,
      description: reqBody.description,
    });

    const res = await fetch(dispatcherUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reqBody),
    });

    const json = await res.json().catch(() => null);
    console.log("DISPATCHER RESPONSE:", json);

    if (!res.ok || json?.result !== 0 || !json?.url) {
      console.error("Dispatcher rejected", { status: res.status, json });
      return new Response(null, { status: 200 });
    }

    const paymentUrl = String(json.url);
    const orderIdNumeric = Number(payload?.id);

    await updateOrder(orderIdNumeric, paymentUrl);

    // Email dërgohet veç si bonus — mos e blloko webhook-un nëse dështon
    try {
      await sendPaymentEmail(payload?.email, paymentUrl, payload?.id);
    } catch (e) {
      console.error("sendPaymentEmail failed (non-fatal):", e);
    }

    console.log("SUCCESS: order updated + payment email attempted");
    return new Response(null, { status: 200 });
  } catch (e) {
    console.error("Webhook error:", e);
    return new Response(null, { status: 200 });
  }
};
