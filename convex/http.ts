import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { api } from "./_generated/api";

const http = httpRouter();

http.route({
  path: "/clerk-webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const payload = await request.json();
    const eventType = payload.type;

    if (eventType === "user.created" || eventType === "user.updated") {
      const clerkUser = payload.data;
      await ctx.runMutation(internal.users.upsertUser, {
        clerkId: clerkUser.id,
        email: clerkUser.email_addresses[0]?.email_address || "",
      });
    }

    return new Response(null, { status: 200 });
  }),
});

export default http;

// App Store Server Notifications V2 ingestion
http.route({
  path: "/appstore/notifications",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const body = await request.json();
      const signedPayload = body?.signedPayload;
      if (!signedPayload) return new Response("missing signedPayload", { status: 400 });

      // Verify & decode in a Node action to avoid bundling Node built-ins here
      const decoded = await ctx.runAction(api.integrations.appStore.decodeAppStoreNotification, {
        signedPayload,
      });

const data = decoded?.data;
      const notificationType = decoded?.notificationType || "unknown";
      const subtype = decoded?.subtype || undefined;
      const bundleId = data?.bundleId || undefined;
      const environment = decoded?.environment || undefined;

      // Try to associate by originalTransactionId if present; otherwise undefined for now.
      const originalTransactionId =
        data?.transactionInfo?.originalTransactionId ||
        data?.renewalInfo?.originalTransactionId ||
        undefined;

      // Persist notification for later mapping to a user
      await ctx.runMutation(internal.syncHelpers.recordAppStoreNotification, {
        userId: undefined,
        notificationType,
        subtype,
        originalTransactionId,
        bundleId,
        environment,
        rawPayload: JSON.stringify(decoded),
      });

      return new Response(null, { status: 204 });
    } catch (e) {
      return new Response("invalid notification", { status: 400 });
    }
  }),
});
