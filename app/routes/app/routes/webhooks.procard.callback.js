import crypto from "crypto";

const API_VERSION = "2025-01";

function normalizeAmount(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "0";
  return n.toString();
}

function verifyCallbackSignature(body) {
  const secret = process.env.PROCARD_SECRET;
  if (!secret) throw new Error("Missing PROCARD_SECRET");

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

async function shopifyRest(path, { method = "GET", body } = {}) {
  const shop = process.env.SHOPIFY_STORE_DOMAIN;
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  if (!shop) throw new Error("Missing SHOPIFY_STORE_DOMAIN");
  if (!token) throw new Error("Missing SHOPIFY_ADMIN_ACCESS_TOKEN");

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

async function findOrderByOrderNumber(orderNumber) {
  // Search orders by name: #1013 etc
  const q = encodeURIComponent(`name:#${orderNumber}`);
  const res = await shopifyRest(
    `/orders.json?status=any&limit=1&name=${encodeURIComponent("#" + orderNumber)}`,
  ).catch(() => null);

  // fallback using /orders.json?name= is sometimes limited; safer:
  const search = await shopifyRest(
    `/orders.json?status=any&limit=1&fields=id,name,tags,financial_status&name=${encodeURIComponent("#" + orderNumber)}`,
  ).catch(() => null);

  const order = search?.orders?.[0] || res?.orders?.[0] || null;
  return order;
}

async function tagOrder(orderIdNumeric, extraTags) {
  const current = await shopifyRest(`/orders/${orderIdNumeric}.json`);
  const tags = String(current?.order?.tags || "");
  const nextTags = Array.from(
    new Set([
      ...tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      ...extraTags,
    ]),
  ).join(", ");

  await shopifyRest(`/orders/${orderIdNumeric}.json`, {
    method: "PUT",
    body: { order: { id: orderIdNumeric, tags: nextTags } },
  });

  return nextTags.split(",").map((t) => t.trim());
}

/* ---- PostOffice (same logic as you had) ---- */
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

function getOrderPriceFromPayload(order) {
  const candidates = [
    order?.current_total_price,
    order?.total_price,
    order?.current_total_price_set?.shop_money?.amount,
    order?.total_price_set?.shop_money?.amount,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

async function sendToPostOffice(order) {
  const baseUrl = process.env.POSTOFFICE_BASE_URL;
  const token = process.env.POSTOFFICE_TOKEN;
  const bulkInsertPath =
    process.env.POSTOFFICE_BULK_INSERT_PATH || "/api/order/bulk-insert";

  if (!baseUrl) throw new Error("Missing POSTOFFICE_BASE_URL");
  if (!token) throw new Error("Missing POSTOFFICE_TOKEN");

  const shipping = order?.shipping_address;

  if (
    !shipping?.address1 ||
    !shipping?.city ||
    !shipping?.first_name ||
    !shipping?.last_name
  ) {
    console.error("Skipping PostOffice: missing shipping fields", {
      orderId: order?.id,
      orderNumber: order?.order_number,
    });
    return;
  }

  const firstName = shipping?.first_name || "";
  const lastName = shipping?.last_name || "";
  const address = shipping?.address1 || "";
  const addressDetails = shipping?.address2 || "";
  const phone = shipping?.phone || order?.phone || "";

  const cityLabel = normalizeCityLabel(shipping?.city);
  const countryId = countryIdFromShippingAddress(shipping);

  const width = parseNumberOr(process.env.POSTOFFICE_DEFAULT_WIDTH_CM, 20);
  const length = parseNumberOr(process.env.POSTOFFICE_DEFAULT_LENGTH_CM, 20);
  const height = parseNumberOr(process.env.POSTOFFICE_DEFAULT_HEIGHT_CM, 20);
  const weight = parseNumberOr(process.env.POSTOFFICE_DEFAULT_WEIGHT_KG, 1);

  const orderPrice = getOrderPriceFromPayload(order);
  const orderDescription = order?.note || "";
  const packageDescription = (order?.line_items || [])
    .map((li) => `${li?.title ?? ""} x${li?.quantity ?? 1}`.trim())
    .filter(Boolean)
    .join(", ");

  const refid = String(order?.order_number || order?.name || order?.id || "");
  const ordersRealPrice = orderPrice;

  const body = [
    {
      FirstName: firstName,
      LastName: lastName,
      Address: address,
      AddressDetails: addressDetails || undefined,
      Phone: phone,
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
      OrderDescription: orderDescription || undefined,
      PackageDescription: packageDescription || undefined,
      Refid: refid || undefined,
      SectionId: -1,
      SellerId: -1,
      UserId: -1,
      CountryId: countryId,
      CityLabel: cityLabel,
      OrdersRealPrice: ordersRealPrice,
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

  if (!verifyCallbackSignature(body))
    return new Response("Invalid signature", { status: 401 });

  const status = String(body?.transactionStatus || "");
  const orderRef = String(body?.orderReference || "");
  if (!orderRef) return new Response("Missing orderReference", { status: 400 });

  try {
    if (status !== "Approved") return new Response("OK", { status: 200 });

    const order = await findOrderByOrderNumber(orderRef);
    if (!order?.id) return new Response("Order not found", { status: 404 });

    const tags = await tagOrder(Number(order.id), ["paid_procard"]);

    const alreadySent = tags.includes("sent_to_postoffice");
    if (!alreadySent) {
      const full = await shopifyRest(`/orders/${order.id}.json`);
      const fullOrder = full?.order;
      if (fullOrder) {
        await sendToPostOffice(fullOrder);
        await tagOrder(Number(order.id), ["sent_to_postoffice"]);
      }
    }

    return new Response("OK", { status: 200 });
  } catch (e) {
    console.error("Callback processing failed", e);
    return new Response("Callback failed", { status: 502 });
  }
};
