import { authenticate } from "../shopify.server";

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
      console.error("PostOffice bulk-insert redirect", {
        status: res.status,
        from: currentUrl,
        to: location,
      });

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

export const action = async ({ request }) => {
  const { topic, payload } = await authenticate.webhook(request);

  if (topic !== "ORDERS_FULFILLED") {
    return new Response(null, { status: 200 });
  }

  const baseUrl = process.env.POSTOFFICE_BASE_URL;
  const token = process.env.POSTOFFICE_TOKEN;
  const bulkInsertPath =
    process.env.POSTOFFICE_BULK_INSERT_PATH || "/api/order/bulk-insert";

  if (!baseUrl) {
    console.error("Missing POSTOFFICE_BASE_URL env var");
    return new Response("Missing POSTOFFICE_BASE_URL", { status: 500 });
  }

  if (!token) {
    console.error("Missing POSTOFFICE_TOKEN env var");
    return new Response("Missing POSTOFFICE_TOKEN", { status: 500 });
  }

  const shipping = payload?.shipping_address;

  if (
    !shipping?.address1 ||
    !shipping?.city ||
    !shipping?.first_name ||
    !shipping?.last_name
  ) {
    console.error(
      "Skipping PostOffice bulk-insert: missing required shipping fields",
      {
        orderId: payload?.id,
        orderNumber: payload?.order_number,
        hasShipping: Boolean(shipping),
        address1: Boolean(shipping?.address1),
        city: Boolean(shipping?.city),
        first_name: Boolean(shipping?.first_name),
        last_name: Boolean(shipping?.last_name),
      },
    );
    return new Response(null, { status: 200 });
  }

  const firstName = shipping?.first_name || "";
  const lastName = shipping?.last_name || "";
  const address = shipping?.address1 || "";
  const addressDetails = shipping?.address2 || "";
  const phone = shipping?.phone || payload?.phone || "";

  const cityLabel = normalizeCityLabel(shipping?.city);
  const countryId = countryIdFromShippingAddress(shipping);

  const width = parseNumberOr(process.env.POSTOFFICE_DEFAULT_WIDTH_CM, 20);
  const length = parseNumberOr(process.env.POSTOFFICE_DEFAULT_LENGTH_CM, 20);
  const height = parseNumberOr(process.env.POSTOFFICE_DEFAULT_HEIGHT_CM, 20);
  const weight = parseNumberOr(process.env.POSTOFFICE_DEFAULT_WEIGHT_KG, 1);

  const orderPrice = getOrderPriceFromPayload(payload);

  const orderDescription = payload?.note || "";
  const packageDescription = (payload?.line_items || [])
    .map((li) => `${li?.title ?? ""} x${li?.quantity ?? 1}`.trim())
    .filter(Boolean)
    .join(", ");

  const refid = String(
    payload?.order_number || payload?.name || payload?.id || "",
  );

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
      Exchangeable: false,
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

  try {
    const url = `${baseUrl.replace(/\/$/, "")}${bulkInsertPath.startsWith("/") ? "" : "/"}${bulkInsertPath}`;
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    };
    const jsonBody = JSON.stringify(body);

    const res = await postJsonWithRedirects(url, {
      headers,
      body: jsonBody,
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error("PostOffice bulk-insert failed", {
        status: res.status,
        url: res.url,
        body: errorText,
      });
      return new Response(errorText || "PostOffice bulk-insert failed", {
        status: 502,
      });
    }

    await res.text();

    return new Response(null, { status: 200 });
  } catch (e) {
    console.error("Error calling PostOffice bulk-insert", e);
    return new Response("Error calling PostOffice bulk-insert", {
      status: 502,
    });
  }
};
