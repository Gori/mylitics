import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex } from "@convex-dev/better-auth/plugins";
import { betterAuth } from "better-auth";
import { magicLink } from "better-auth/plugins";
import { components } from "./_generated/api";
import { DataModel } from "./_generated/dataModel";
import { query, mutation } from "./_generated/server";

// Context type that has db access (query/mutation contexts)
type DbContext = GenericCtx<DataModel> & { db: any };

export const authComponent = createClient<DataModel>((components as any).betterAuth, {
  triggers: {
    user: {
      onCreate: async (ctx, user) => {
        const existing = await ctx.db
          .query("users")
          .withIndex("by_email", (q: any) => q.eq("email", user.email))
          .first();

        if (!existing) {
          await ctx.db.insert("users", {
            email: user.email,
            name: user.name ?? undefined,
            image: user.image ?? undefined,
          });
        }
      },
      onUpdate: async (ctx, user) => {
        const existing = await ctx.db
          .query("users")
          .withIndex("by_email", (q: any) => q.eq("email", user.email))
          .first();

        if (existing) {
          await ctx.db.patch(existing._id, {
            name: user.name ?? undefined,
            image: user.image ?? undefined,
          });
        }
      },
    },
  },
});

// Helper to get user ID from auth
// BetterAuth uses 'user' table, but we use 'users' table
// We need to find or create the user in our 'users' table
// This function only works in query/mutation contexts (not actions)
export async function getAuthUserId(ctx: DbContext): Promise<import("./_generated/dataModel").Id<"users"> | null> {
  const authUser = await authComponent.getAuthUser(ctx);
  if (!authUser) return null;
  
  const user = await ctx.db
    .query("users")
    .withIndex("by_email", (q: any) => q.eq("email", authUser.email))
    .first();
  
  if (!user) {
    throw new Error("User profile not found for authenticated user");
  }
  
  return user._id;
}

export const createAuth = (
  ctx: GenericCtx<DataModel>,
  { optionsOnly } = { optionsOnly: false }
) => {
  const siteUrl = process.env.SITE_URL;
  if (!siteUrl) {
    throw new Error("SITE_URL is not set");
  }

  const authSecret = process.env.BETTER_AUTH_SECRET;
  if (!authSecret) {
    throw new Error("BETTER_AUTH_SECRET is not set");
  }
 
  return betterAuth({
    logger: {
      disabled: optionsOnly,
    },
    baseURL: siteUrl,
    secret: authSecret,
    trustedOrigins: [siteUrl, "http://localhost:3000"],
    database: authComponent.adapter(ctx),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
    },
    plugins: [
      convex(),
      magicLink({
        sendMagicLink: async ({ email, url }) => {
          // TODO: Implement email sending via service like Resend
          console.log(`Magic link for ${email}: ${url}`);
        },
      }),
    ],
  });
};

// Get current authenticated user
export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    return authComponent.getAuthUser(ctx);
  },
});

export const ensureUserProfile = mutation({
  args: {},
  handler: async (ctx) => {
    const authUser = await authComponent.getAuthUser(ctx);
    if (!authUser) {
      throw new Error("Not authenticated");
    }

    const existing = await ctx.db
      .query("users")
      .withIndex("by_email", (q: any) => q.eq("email", authUser.email))
      .first();

    if (existing) {
      const updates: Record<string, any> = {};
      if (existing.name !== authUser.name) {
        updates.name = authUser.name ?? undefined;
      }
      if (existing.image !== authUser.image) {
        updates.image = authUser.image ?? undefined;
      }
      if (Object.keys(updates).length > 0) {
        await ctx.db.patch(existing._id, updates);
      }

      return existing._id;
    }

    return await ctx.db.insert("users", {
      email: authUser.email,
      name: authUser.name ?? undefined,
      image: authUser.image ?? undefined,
    });
  },
});

