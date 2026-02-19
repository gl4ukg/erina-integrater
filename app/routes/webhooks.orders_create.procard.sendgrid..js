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
  if (errs.length) {
    console.error("orderUpdate userErrors", errs);
    throw new Error(errs.map((e) => e.message).join(", "));
  }
}

async function sendEmailWithLink({ to, orderName, paymentUrl }) {
  const apiKey = process.env.SENDGRID_API_KEY;
  const from = process.env.SENDGRID_FROM;

  if (!apiKey || !from) {
    console.warn("SendGrid not configured; skipping email send");
    return;
  }

  const subject = `Linku për pagesë – ${orderName}`;
  const text =
    `Përshëndetje,\n\n` +
    `Klikoni këtu për ta kryer pagesën për porosinë ${orderName}:\n` +
    `${paymentUrl}\n\n` +
    `Porosia përpunohet pasi pagesa të konfirmohet.\n\n` +
    `Faleminderit,\nErina Home`;

  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: from, name: "Erina Home" },
      subject,
      content: [{ type: "text/plain", value: text }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error("SendGrid send failed", { status: res.status, err });
  }
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

    if (!res.ok) {
      console.error("Dispatcher error", { status: res.status, json });
      return new Response("Dispatcher error", { status: 502 });
    }

    if (json?.result !== 0 || !json?.url) {
      console.error("Unexpected dispatcher response", json);
      return new Response("Bad dispatcher response", { status: 502 });
    }

    const paymentUrl = String(json.url);

    await addTagAndNoteAttribute(admin, payload.id, paymentUrl);

    if (payload?.email) {
      await sendEmailWithLink({
        to: payload.email,
        orderName: payload?.name || `#${orderRef}`,
        paymentUrl,
      });
    }

    return new Response(null, { status: 200 });
  } catch (e) {
    console.error("Create payment link failed", e);
    return new Response("Create payment link failed", { status: 502 });
  }
};
