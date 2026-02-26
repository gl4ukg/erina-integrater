import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import crypto from "crypto";

const API_VERSION = "2025-01";

/* ---------------- TOKEN (Offline Session) ---------------- */

async function getOfflineAccessToken(shop) {
  const offlineId = `offline_${shop}`;

  const found = await prisma.session.findMany({
    take: 5,
    select: { id: true },
    orderBy: { id: "asc" },
  });

  console.log("SESSION_IDS_SAMPLE", found);

  const session = await prisma.session.findUnique({
    where: { id: offlineId },
    select: { accessToken: true },
  });

  console.log("LOOKUP_OFFLINE", { offlineId, found: !!session });
  return session?.accessToken || null;
}

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

/* ---------------- SHOPIFY REST ---------------- */

async function shopifyRest(
  shop,
  accessToken,
  path,
  { method = "GET", body } = {},
) {
  const res = await fetch(`https://${shop}/admin/api/${API_VERSION}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  if (!res.ok) {
    console.error("Shopify REST error", { status: res.status, text, json });
    throw new Error(`Shopify REST failed: ${res.status}`);
  }

  return json;
}

/* ---------------- UPDATE ORDER ---------------- */

async function updateOrder(orderIdNumeric, paymentUrl) {
  const current = await shopifyRestWithStaticToken(
    `/orders/${orderIdNumeric}.json`,
  );

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

  await shopifyRestWithStaticToken(`/orders/${orderIdNumeric}.json`, {
    method: "PUT",
    body: { order: { id: orderIdNumeric, tags: nextTags, note_attributes } },
  });
}
/* ---------------- SEND INVOICE EMAIL ---------------- */

async function sendInvoiceEmail(orderIdNumeric, email, paymentUrl) {
  await shopifyRestWithStaticToken(
    `/orders/${orderIdNumeric}/send_invoice.json`,
    {
      method: "POST",
      body: {
        invoice: {
          to: email,
          subject: "Payment link for your order",
          custom_message: `Please pay using this link: ${paymentUrl}`,
        },
      },
    },
  );
}

async function shopifyRestWithStaticToken(path, { method = "GET", body } = {}) {
  const shop = process.env.SHOPIFY_ADMIN_SHOP;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!shop || !token)
    throw new Error("Missing SHOPIFY_ADMIN_SHOP / SHOPIFY_ADMIN_TOKEN");

  const res = await fetch(`https://${shop}/admin/api/${API_VERSION}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
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
    console.error("Shopify REST error", { status: res.status, text, json });
    throw new Error(`Shopify REST failed: ${res.status}`);
  }

  return json;
}
/* ---------------- MAIN ACTION ---------------- */

export const action = async ({ request }) => {
  const { topic, payload } = await authenticate.webhook(request);

  console.log("WEBHOOK HIT:", topic);

  if (topic !== "ORDERS_CREATE") {
    return new Response(null, { status: 200 });
  }

  if (!isManualPayment(payload)) {
    console.log("Not manual payment → skip");
    return new Response(null, { status: 200 });
  }

  const shop = request.headers.get("x-shopify-shop-domain");
  console.log("SHOP:", shop);

  try {
    const accessToken = await getOfflineAccessToken(shop);

    if (!accessToken) {
      console.error("No offline token for shop:", shop);
      return new Response(null, { status: 200 });
    }

    const dispatcherUrl = process.env.PROCARD_DISPATCHER_URL;
    const merchant_id = process.env.PROCARD_MERCHANT_ID;

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
      console.error("Dispatcher rejected", json);
      return new Response(null, { status: 200 });
    }

    const paymentUrl = String(json.url);
    const orderIdNumeric = Number(payload?.id);

    await updateOrder(orderIdNumeric, paymentUrl);
    await sendInvoiceEmail(orderIdNumeric, payload?.email || "", paymentUrl);

    console.log("SUCCESS: invoice sent + order updated");

    return new Response(null, { status: 200 });
  } catch (e) {
    console.error("Webhook error:", e);
    return new Response(null, { status: 200 }); // NEVER 502
  }
};
