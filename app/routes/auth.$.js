import { authenticate, login } from "../shopify.server";

export const loader = async ({ request, params }) => {
  const splat = params["*"]; // p.sh. "login" ose "callback"

  if (splat === "login") {
    return login(request); // ✅ kjo duhet për /auth/login
  }

  // ✅ kjo e finalizon auth-in dhe ruan session në DB për /auth/callback
  const result = await authenticate.admin(request);
  if (result instanceof Response) return result;

  // nëse s’ka redirect automatik, ridrejto në një faqe (mundet edhe "/")
  return new Response(null, {
    status: 302,
    headers: { Location: "/" },
  });
};

export const action = async ({ request, params }) => {
  const splat = params["*"];

  if (splat === "login") {
    return login(request);
  }

  const result = await authenticate.admin(request);
  if (result instanceof Response) return result;

  return new Response(null, { status: 200 });
};
