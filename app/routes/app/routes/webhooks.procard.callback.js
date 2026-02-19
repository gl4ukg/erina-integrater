import crypto from "crypto";
import { shopify } from "../shopify.server"; // adjust path if needed

const API_VERSION = "2025-01";

function normalizeAmount(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "0";
  return n.toString();
}

function verifyCallbackSignature(body) {
  const secret = process.env.PROCARD_SECRET;
  if (!secret) throw new Error("Missing PROCARD_SECRET");

  // Docs: merchantAccount, orderReference, amount, currency, merchantSignature
  const merchant_id = String(body?.merchantAccount || "");
  const orderReference = String(body?.orderReference || "");
  const amount = normalizeAmount(body?.amount);
  const currency = String(body?.currency || "");
  const merchantSignature = String(body?.merchantSignature || "");

  if (!merchant_id || !orderReference || !currency || !merchantSignature)
    return false;

  const toSign = `${merchant_id};${orderReference};${amount};${currency}`;
  const expected = crypto
    .createHmac("sha512", secret)
    .update(toSign, "utf8")
    .digest("hex");

  return expected === merchantSignature;
}

async function getOfflineAdminGraphqlClient() {
  const shopDomain = process.env.SHOP_DOMAIN;
  if (!shopDomain) throw new Error("Missing SHOP_DOMAIN env var");

  const sessionId = `offline_${shopDomain}`;
  const session = await shopify.sessionStorage.loadSession(sessionId);

  if (!session) {
    throw new Error(
      `No offline session found for ${shopDomain}. Reinstall the app on that store to create offline session.`,
    );
  }

  return new shopify.api.clients.Graphql({ session, apiVersion: API_VERSION });
}

async function findOrderByOrderNumber(admin, orderNumber) {
  const q = `name:#${orderNumber}`;

  const result = await admin.query({
    data: {
      query: `
        query FindOrder($q: String!) {
          orders(first: 1, query: $q) {
            nodes { id name displayFinancialStatus tags }
          }
        }
      `,
      variables: { q },
    },
  });

  return result?.body?.data?.orders?.nodes?.[0] || null;
}

async function orderMarkAsPaid(admin, orderGid) {
  const result = await admin.query({
    data: {
      query: `
        mutation MarkPaid($input: OrderMarkAsPaidInput!) {
          orderMarkAsPaid(input: $input) {
            order { id displayFinancialStatus }
            userErrors { field message }
          }
        }
      `,
      variables: { input: { id: orderGid } },
    },
  });

  const errs = result?.body?.data?.orderMarkAsPaid?.userErrors || [];
  if (errs.length) throw new Error(errs.map((e) => e.message).join(", "));
}

async function orderUpdateTags(admin, orderGid, tags) {
  const result = await admin.query({
    data: {
      query: `
        mutation UpdateOrder($input: OrderInput!) {
          orderUpdate(input: $input) {
            order { id tags }
            userErrors { field message }
          }
        }
      `,
      variables: { input: { id: orderGid, tags } },
    },
  });

  const errs = result?.body?.data?.orderUpdate?.userErrors || [];
  if (errs.length) throw new Error(errs.map((e) => e.message).join(", "));
}

async function fetchFullOrderJSONByGid(orderGid) {
  const shopDomain = process.env.SHOP_DOMAIN;
  if (!shopDomain) throw new Error("Missing SHOP_DOMAIN env var");

  const sessionId = `offline_${shopDomain}`;
  const session = await shopify.sessionStorage.loadSession(sessionId);
  if (!session) throw new Error("Missing offline session");

  const numericId = String(orderGid).split("/").pop();

  const res = await fetch(
    `https://${shopDomain}/admin/api/${API_VERSION}/orders/${numericId}.json`,
    {
      method: "GET",
      headers: { "X-Shopify-Access-Token": session.accessToken },
    },
  );

  const json = await res.json().catch(() => null);
  return json?.order || null;
}

/* ---- POST OFFICE (bulk insert): keep your exact existing functions ---- */
function normalizeCityLabel(city) {
  if (!city) return "";
  return String(city).trim();
}

async function postJsonWithRedirects(url, { headers, body, maxRedirects = 3 }) {
  let currentUrl = url;
  for (let attempt = 0; attempt <= maxRedirects; attempt++) {
    const res = await fetch(currentUrl, {
      method: "POST",
      redirect: "manual",
      headers,
      body,
    });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get("location");
      if (!location) return res;
      currentUrl = new URL(location, currentUrl).toString();
      if (attempt === maxRedirects) return res;
      continue;
    }
    return res;
  }
  throw new Error("Too many redirects");
}

function countryIdFromShippingAddress(shippingAddress) {
  const code = (
    shippingAddress?.country_code ||
    shippingAddress?.countryCodeV2 ||
    shippingAddress?.country_code_v2 ||
    shippingAddress?.country ||
    ""
  )
    .toString()
    .trim()
    .toUpperCase();

  if (code === "XK" || code === "KOSOVO") return 1;
  if (code === "AL" || code === "ALBANIA") return 2;
  if (
    code === "MK" ||
    code === "NM" ||
    code === "NORTH MACEDONIA" ||
    code === "MACEDONIA"
  )
    return 3;
  return 1;
}

function parseNumberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function getOrderPriceFromPayload(payload) {
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

async function sendToPostOffice(orderPayload) {
  const baseUrl = process.env.POSTOFFICE_BASE_URL;
  const token = process.env.POSTOFFICE_TOKEN;
  const bulkInsertPath =
    process.env.POSTOFFICE_BULK_INSERT_PATH || "/api/order/bulk-insert";

  if (!baseUrl) throw new Error("Missing POSTOFFICE_BASE_URL");
  if (!token) throw new Error("Missing POSTOFFICE_TOKEN");

  const shipping = orderPayload?.shipping_address;
  if (
    !shipping?.address1 ||
    !shipping?.city ||
    !shipping?.first_name ||
    !shipping?.last_name
  ) {
    console.error("Skipping PostOffice: missing shipping fields", {
      orderId: orderPayload?.id,
      orderNumber: orderPayload?.order_number,
    });
    return;
  }

  const cityLabel = normalizeCityLabel(shipping?.city);
  const countryId = countryIdFromShippingAddress(shipping);

  const width = parseNumberOr(process.env.POSTOFFICE_DEFAULT_WIDTH_CM, 20);
  const length = parseNumberOr(process.env.POSTOFFICE_DEFAULT_LENGTH_CM, 20);
  const height = parseNumberOr(process.env.POSTOFFICE_DEFAULT_HEIGHT_CM, 20);
  const weight = parseNumberOr(process.env.POSTOFFICE_DEFAULT_WEIGHT_KG, 1);

  const orderPrice = getOrderPriceFromPayload(orderPayload);

  const body = [
    {
      FirstName: shipping?.first_name || "",
      LastName: shipping?.last_name || "",
      Address: shipping?.address1 || "",
      AddressDetails: shipping?.address2 || undefined,
      Phone: shipping?.phone || orderPayload?.phone || "",
      Width: width,
      Length: length,
      Height: height,
      Weight: weight,
      Openable: true,
      Fragile: false,
      Declared: false,
      Exchangeable: true,
      Invoice: false,
      OrderPrice: orderPrice,
      OrderDescription: orderPayload?.note || undefined,
      PackageDescription:
        (orderPayload?.line_items || [])
          .map((li) => `${li?.title ?? ""} x${li?.quantity ?? 1}`.trim())
          .filter(Boolean)
          .join(", ") || undefined,
      Refid:
        String(
          orderPayload?.order_number ||
            orderPayload?.name ||
            orderPayload?.id ||
            "",
        ) || undefined,
      SectionId: -1,
      SellerId: -1,
      UserId: -1,
      CountryId: countryId,
      CityLabel: cityLabel,
      OrdersRealPrice: orderPrice,
    },
  ];

  const url = `${baseUrl.replace(/\/$/, "")}${bulkInsertPath.startsWith("/") ? "" : "/"}${bulkInsertPath}`;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };

  const res = await postJsonWithRedirects(url, {
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorText = await res.text();
    console.error("PostOffice bulk-insert failed", {
      status: res.status,
      body: errorText,
    });
    throw new Error(errorText || "PostOffice bulk-insert failed");
  }
  await res.text();
}

export const action = async ({ request }) => {
  const body = await request.json().catch(() => null);
  if (!body) return new Response("Bad JSON", { status: 400 });

  if (!verifyCallbackSignature(body)) {
    return new Response("Invalid signature", { status: 401 });
  }

  const status = String(body?.transactionStatus || "");
  const orderRef = String(body?.orderReference || "");
  if (!orderRef) return new Response("Missing orderReference", { status: 400 });

  try {
    if (status !== "Approved") return new Response("OK", { status: 200 });

    const admin = await getOfflineAdminGraphqlClient();

    const order = await findOrderByOrderNumber(admin, orderRef);
    if (!order?.id) return new Response("Order not found", { status: 404 });

    const tags = Array.isArray(order.tags) ? order.tags : [];
    const alreadySentToPost = tags.includes("sent_to_postoffice");
    const alreadyPaid =
      String(order.displayFinancialStatus || "").toUpperCase() === "PAID";

    if (!alreadyPaid) {
      await orderMarkAsPaid(admin, order.id);
    }

    if (!alreadySentToPost) {
      const fullOrder = await fetchFullOrderJSONByGid(order.id);
      if (fullOrder) {
        await sendToPostOffice(fullOrder);
        const nextTags = Array.from(
          new Set([...tags, "sent_to_postoffice", "paid_procard"]),
        );
        await orderUpdateTags(admin, order.id, nextTags);
      }
    }

    return new Response("OK", { status: 200 });
  } catch (e) {
    console.error("Callback processing failed", e);
    return new Response("Callback failed", { status: 502 });
  }
};
