import { getToken as getTokenNext } from "@convex-dev/better-auth/nextjs";
import { createAuth } from "@/convex/auth";

export const getAuthToken = () => getTokenNext(createAuth);


