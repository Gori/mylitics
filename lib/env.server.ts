const required = (name: string): string => {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is not set`);
  }

  return value;
};

const deriveConvexSiteUrl = (input: string): string => {
  const url = new URL(input);
  const hostname = url.hostname.endsWith(".convex.cloud")
    ? url.hostname.replace(".convex.cloud", ".convex.site")
    : url.hostname;
  const port = url.port ? `:${url.port}` : "";

  return `${url.protocol}//${hostname}${port}`;
};

const nextPublicConvexUrl = required("NEXT_PUBLIC_CONVEX_URL");

const convexSiteUrl = (() => {
  if (process.env.CONVEX_SITE_URL) {
    return process.env.CONVEX_SITE_URL;
  }

  if (process.env.NEXT_PUBLIC_CONVEX_SITE_URL) {
    return process.env.NEXT_PUBLIC_CONVEX_SITE_URL;
  }

  return deriveConvexSiteUrl(nextPublicConvexUrl);
})();

export const serverEnv = {
  siteUrl: required("SITE_URL"),
  nextPublicSiteUrl: required("NEXT_PUBLIC_SITE_URL"),
  nextPublicConvexUrl,
  convexSiteUrl,
};


