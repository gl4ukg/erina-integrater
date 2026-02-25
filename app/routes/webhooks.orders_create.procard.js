import { authenticate } from "../shopify.server";
import crypto from "crypto";

const API_VERSION = "2025-01";
const CURRENCY_ISO_NUMERIC = 978;

// --- TOKEN (Client Credentials Grant) ---
let _cachedToken = null;
let _cachedTokenExpMs = 0;

async function getAdminAccessToken() {
  const shop = process.env.SHOPIFY_STORE_DOMAIN;
  const clientId = process.env.SHOPIFY_API_KEY;
  const clientSecret = process.env.SHOPIFY_API_SECRET;

  if (!shop) throw new Error("Missing SHOPIFY_STORE_DOMAIN");
  if (!clientId) throw new Error("Missing SHOPIFY_API_KEY");
  if (!clientSecret) throw new Error("Missing SHOPIFY_API_SECRET");

  // cache (me buffer 60s)
  const now = Date.now();
  if (_cachedToken && now < _cachedTokenExpMs - 60_000) return _cachedToken;

  // Shopify client credentials grant
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
    }),
  });

  const json = await res.json().catch(() => null);

  if (!res.ok || !json?.access_token) {
    console.error("Token generation failed", { status: res.status, json });
    throw new Error("Failed to generate admin access token");
  }

  _cachedToken = json.access_token;

  // Shopify zakonisht kthen expires_in (sekonda). Nëse s’vjen, e lëmë 1 orë.
  const expiresInSec = Number(json.expires_in);
  _cachedTokenExpMs =
    now + (Number.isFinite(expiresInSec) ? expiresInSec * 1000 : 3600_000);

  return _cachedToken;
}

// --- your existing helpers ---
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

  return (
    names.includes("manual") ||
    names.includes("pay by card (email)") || // <- kjo
    names.includes("pay by card") // <- opsionale
  );
}

async function shopifyRest(path, { method = "GET", body } = {}) {
  const shop = process.env.SHOPIFY_STORE_DOMAIN;
  if (!shop) throw new Error("Missing SHOPIFY_STORE_DOMAIN");

  const token = await getAdminAccessToken();

  const res = await fetch(`https://${shop}/admin/api/${API_VERSION}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  const json = text ? JSON.parse(text) : null;

  if (!res.ok) {
    console.error("Shopify REST error", { status: res.status, json });
    throw new Error(`Shopify REST failed: ${res.status}`);
  }

  return json;
}

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
    body: {
      order: {
        id: orderIdNumeric,
        tags: nextTags,
        note_attributes,
      },
    },
  });
}

async function sendInvoiceEmail(orderIdNumeric) {
  await shopifyRest(`/orders/${orderIdNumeric}/send_invoice.json`, {
    method: "POST",
    body: { invoice: {} },
  });
}

export const action = async ({ request }) => {
  const { topic, payload } = await authenticate.webhook(request);

  console.log("topic:", topic);
  console.log("payment_gateway_names:", payload?.payment_gateway_names);

  if (topic !== "ORDERS_CREATE") return new Response(null, { status: 200 });
  if (!isManualPayment(payload)) return new Response(null, { status: 200 });

  const dispatcherUrl = process.env.PROCARD_DISPATCHER_URL;
  const merchant_id = process.env.PROCARD_MERCHANT_ID;

  if (!dispatcherUrl)
    return new Response("Missing PROCARD_DISPATCHER_URL", { status: 500 });
  if (!merchant_id)
    return new Response("Missing PROCARD_MERCHANT_ID", { status: 500 });

  const orderRef = String(payload?.id || "");
  const amount = getOrderTotal(payload);
  const description = `Erina Home ${orderRef}`;

  console.log("ORDER", {
    orderId: payload?.id,
    orderNumber: payload?.order_number,
    currency: payload?.currency,
  });

  const callback_url = process.env.PROCARD_CALLBACK_URL;
  const approve_url = process.env.PROCARD_APPROVE_URL;
  const decline_url = process.env.PROCARD_DECLINE_URL;
  const cancel_url = process.env.PROCARD_CANCEL_URL;

  if (!callback_url || !approve_url || !decline_url || !cancel_url) {
    return new Response("Missing PROCARD_*_URL env vars", { status: 500 });
  }

  const reqBody = {
    operation: "Purchase",
    merchant_id,
    order_id: orderRef,
    amount: Number(normalizeAmount(amount)),
    currency_iso: String(CURRENCY_ISO_NUMERIC),
    description,
    add_params: {
      shopifyOrderId: String(payload?.id || ""),
      shopifyOrderName: String(payload?.name || ""),
    },
    approve_url,
    decline_url,
    cancel_url,
    callback_url,
    redirect: 0,
    client_first_name:
      payload?.shipping_address?.first_name ||
      payload?.customer?.first_name ||
      "",
    client_last_name:
      payload?.shipping_address?.last_name ||
      payload?.customer?.last_name ||
      "",
    email: payload?.email || "",
    phone: payload?.phone || payload?.shipping_address?.phone || "",
  };

  reqBody.signature = makeRequestSignature({
    merchant_id: reqBody.merchant_id,
    order_id: reqBody.order_id,
    amount: reqBody.amount,
    currency_iso: reqBody.currency_iso,
    description: reqBody.description,
  });

  try {
    const res = await fetch(dispatcherUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reqBody),
    });

    const json = await res.json().catch(() => null);

    console.log("DISPATCHER", { status: res.status, json });
    if (!res.ok) {
      console.error("Dispatcher error", { status: res.status, json });
      return new Response("Dispatcher error", { status: 502 });
    }

    if (json?.result !== 0 || !json?.url) {
      console.error("Dispatcher rejected", json);
      return new Response("OK", { status: 200 });
      // console.error("Unexpected dispatcher response", json);
      // return new Response("Bad dispatcher response", { status: 502 });
    }

    const paymentUrl = String(json.url);

    const orderIdNumeric = Number(payload?.id);
    await updateOrder(orderIdNumeric, paymentUrl);
    await sendInvoiceEmail(orderIdNumeric);
    console.log("UPDATED_ORDER", { orderIdNumeric, paymentUrl });
    return new Response(null, { status: 200 });
  } catch (e) {
    console.error("Create payment link failed", e);
    return new Response("Create payment link failed", { status: 502 });
  }
};
