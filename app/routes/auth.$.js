import { authenticate, login } from "../shopify.server";

export const loader = async ({ request, params }) => {
  const splat = params["*"]; // "login" ose "shopify/callback" etj.

  console.log("AUTH ROUTE HIT:", splat, request.url);

  if (splat === "login") {
    return login(request);
  }

  if (splat === "shopify/callback") {
    const result = await authenticate.admin(request);
    if (result instanceof Response) return result;
    return new Response(null, { status: 302, headers: { Location: "/" } });
  }

  return new Response("Not found", { status: 404 });
};

export const action = async ({ request, params }) => {
  const splat = params["*"];
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") || "";
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop)) {
    return new Response("Invalid shop", { status: 400 });
  }
  if (splat === "login") {
    return login(request);
  }

  const result = await authenticate.admin(request);
  if (result instanceof Response) return result;

  return new Response(null, { status: 200 });
};
