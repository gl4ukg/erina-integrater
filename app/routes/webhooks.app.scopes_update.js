import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  const { topic } = await authenticate.webhook(request);

  if (topic !== "APP_SCOPES_UPDATE") {
    return new Response(null, { status: 200 });
  }

  return new Response(null, { status: 200 });
};
