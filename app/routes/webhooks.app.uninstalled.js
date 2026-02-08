import prisma from "../db.server";
import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  const { topic, shop } = await authenticate.webhook(request);

  if (topic !== "APP_UNINSTALLED") {
    return new Response(null, { status: 200 });
  }

  await prisma.session.deleteMany({ where: { shop } });

  return new Response(null, { status: 200 });
};
