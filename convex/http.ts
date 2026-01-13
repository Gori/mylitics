import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { api } from "./_generated/api";
import { authComponent, createAuth } from "./auth";

const http = httpRouter();

// Register BetterAuth routes
authComponent.registerRoutes(http, createAuth);

// Type for decoded App Store notification payload (library types are incomplete)
type DecodedNotification = {
  notificationType?: string;
  subtype?: string;
  environment?: string;
  data?: {
    bundleId?: string;
    transactionInfo?: { originalTransactionId?: string };
    renewalInfo?: { originalTransactionId?: string };
  };
};

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
      const rawDecoded = await ctx.runAction(api.integrations.appStore.decodeAppStoreNotification, {
        signedPayload,
      });

      // Cast to our type since the library types are incomplete
      const decoded = rawDecoded as DecodedNotification | null;
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

      // Persist notification for later mapping to an app
      await ctx.runMutation(internal.syncHelpers.recordAppStoreNotification, {
        appId: undefined,
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

export default http;
