import { GenericQueryCtx, GenericMutationCtx } from "convex/server";
import { DataModel, Id } from "../_generated/dataModel";
import { getAuthUserId } from "../auth";

type QueryCtx = GenericQueryCtx<DataModel>;
type MutationCtx = GenericMutationCtx<DataModel>;

/**
 * Get the authenticated user's ID.
 * Returns null if not authenticated.
 */
export async function getUserId(ctx: QueryCtx | MutationCtx): Promise<Id<"users"> | null> {
  const userId = await getAuthUserId(ctx);
  return userId || null;
}

/**
 * Get the authenticated user's ID.
 * Throws an error if not authenticated.
 */
export async function requireUserId(ctx: QueryCtx | MutationCtx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Not authenticated");
  return userId;
}

/**
 * Validate that the current user owns the specified app.
 * Throws an error if not authenticated, app not found, or not authorized.
 * Returns the app document if authorized.
 */
export async function validateAppOwnership(
  ctx: QueryCtx | MutationCtx,
  appId: Id<"apps">
) {
  const userId = await requireUserId(ctx);

  const app = await ctx.db.get(appId);
  if (!app) throw new Error("App not found");
  if (app.userId !== userId) throw new Error("Not authorized");

  return app;
}
