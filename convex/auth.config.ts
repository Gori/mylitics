const convexSiteUrl = process.env.CONVEX_SITE_URL;

if (!convexSiteUrl) {
  throw new Error("CONVEX_SITE_URL is not set");
}

export default {
  providers: [
    {
      domain: convexSiteUrl,
      applicationID: "convex",
    },
  ],
};

