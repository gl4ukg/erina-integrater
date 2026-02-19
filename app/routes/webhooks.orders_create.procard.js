import { authenticate } from "../shopify.server";
import crypto from "crypto";

const CURRENCY_ISO_NUMERIC = 978; // EUR

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

// IMPORTANT: ideally match your exact manual gateway name once you log it
function isManualPayment(payload) {
  const names = (payload?.payment_gateway_names || []).map((x) =>
    String(x || "").toLowerCase(),
  );
  return names.includes("manual");
}

async function addTagAndNoteAttribute(admin, orderIdNumeric, paymentUrl) {
  const mutation = `
    mutation UpdateOrder($input: OrderInput!) {
      orderUpdate(input: $input) {
        order { id tags }
        userErrors { field message }
      }
    }
  `;

  const variables = {
    input: {
      id: `gid://shopify/Order/${orderIdNumeric}`,
      tags: ["procard_link_sent"],
      noteAttributes: [{ name: "procard_payment_url", value: paymentUrl }],
    },
  };

  const res = await admin.graphql(mutation, { variables });
  const json = await res.json();
  const errs = json?.data?.orderUpdate?.userErrors || [];
  if (errs.length) throw new Error(errs.map((e) => e.message).join(", "));
}

async function sendInvoiceEmail(admin, orderIdNumeric) {
  const mutation = `
    mutation OrderInvoiceSend($orderId: ID!, $email: EmailInput) {
      orderInvoiceSend(id: $orderId, email: $email) {
        order { id }
        userErrors { message }
      }
    }
  `;

  // We can omit "email" to let Shopify send to the order’s email using your template.
  // Passing customMessage sometimes affects template rendering; so safest is: no customMessage,
  // and use the Notification template to print note_attributes.
  const variables = {
    orderId: `gid://shopify/Order/${orderIdNumeric}`,
    email: null,
  };

  const res = await admin.graphql(mutation, { variables });
  const json = await res.json();

  const errs = json?.data?.orderInvoiceSend?.userErrors || [];
  if (errs.length) throw new Error(errs.map((e) => e.message).join(", "));
}

export const action = async ({ request }) => {
  const { topic, payload, admin } = await authenticate.webhook(request);

  if (topic !== "ORDERS_CREATE") return new Response(null, { status: 200 });
  if (!isManualPayment(payload)) return new Response(null, { status: 200 });

  const dispatcherUrl = process.env.PROCARD_DISPATCHER_URL;
  const merchant_id = process.env.PROCARD_MERCHANT_ID;

  if (!dispatcherUrl)
    return new Response("Missing PROCARD_DISPATCHER_URL", { status: 500 });
  if (!merchant_id)
    return new Response("Missing PROCARD_MERCHANT_ID", { status: 500 });

  const callback_url = process.env.PROCARD_CALLBACK_URL;
  const approve_url = process.env.PROCARD_APPROVE_URL;
  const decline_url = process.env.PROCARD_DECLINE_URL;
  const cancel_url = process.env.PROCARD_CANCEL_URL;

  if (!callback_url || !approve_url || !decline_url || !cancel_url) {
    return new Response("Missing PROCARD_*_URL env vars", { status: 500 });
  }

  const orderRef = String(
    payload?.order_number || payload?.name || payload?.id || "",
  );
  const amount = getOrderTotal(payload);
  const description = `Erina Home ${orderRef}`;

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

    if (!res.ok) return new Response("Dispatcher error", { status: 502 });
    if (json?.result !== 0 || !json?.url)
      return new Response("Bad dispatcher response", { status: 502 });

    const paymentUrl = String(json.url);

    // 1) save payment url on order
    await addTagAndNoteAttribute(admin, payload.id, paymentUrl);

    // 2) send Shopify invoice email (uses Notification template)
    await sendInvoiceEmail(admin, payload.id);

    return new Response(null, { status: 200 });
  } catch (e) {
    console.error("Create payment link failed", e);
    return new Response("Create payment link failed", { status: 502 });
  }
};
