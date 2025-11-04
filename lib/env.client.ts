const required = (name: string): string => {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is not set`);
  }

  return value;
};

export const clientEnv = {
  nextPublicSiteUrl: required("NEXT_PUBLIC_SITE_URL"),
  nextPublicConvexUrl: required("NEXT_PUBLIC_CONVEX_URL"),
};


