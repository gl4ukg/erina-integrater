import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const result = await authenticate.admin(request);
  if (result instanceof Response) return result;
  return null;
};

export const action = async ({ request }) => {
  const result = await authenticate.admin(request);
  if (result instanceof Response) return result;
  return null;
};
