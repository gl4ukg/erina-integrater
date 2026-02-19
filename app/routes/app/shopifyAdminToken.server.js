let cachedToken = null;
let cachedTokenExpiresAt = 0;

export async function getAdminAccessToken() {
  const now = Date.now();

  // Shopify token zakonisht vlen ~24h; ne i japim buffer
  if (cachedToken && now < cachedTokenExpiresAt) {
    return cachedToken;
  }

  const res = await fetch(
    `https://${process.env.SHOP_DOMAIN}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: process.env.SHOPIFY_API_KEY,
        client_secret: process.env.SHOPIFY_API_SECRET,
      }),
    },
  );

  const data = await res.json();

  if (!data?.access_token) {
    throw new Error(`Failed to generate admin token: ${JSON.stringify(data)}`);
  }

  cachedToken = data.access_token;

  // 23h cache (buffer), që mos të bjerë në mes
  cachedTokenExpiresAt = now + 23 * 60 * 60 * 1000;

  return cachedToken;
}
