"use client";

import { createContext, useContext, ReactNode } from "react";
import { useParams, useRouter, usePathname } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { authClient } from "@/lib/auth-client";

interface AppContextType {
  appId: Id<"apps">;
  appSlug: string;
  appName: string;
  currency: string;
}

const AppContext = createContext<AppContextType | null>(null);

export function useApp() {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error("useApp must be used within AppLayout");
  }
  return context;
}

export default function AppLayout({ children }: { children: ReactNode }) {
  const params = useParams();
  const router = useRouter();
  const pathname = usePathname();
  const slug = params.slug as string;

  const app = useQuery(api.apps.getAppBySlug, { slug });
  const allApps = useQuery(api.apps.getUserApps);

  const handleSignOut = async () => {
    await authClient.signOut();
    router.push("/");
  };

  if (app === undefined || allApps === undefined) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white">
        <div>Loading...</div>
      </div>
    );
  }

  const appContext: AppContextType = {
    appId: app._id,
    appSlug: app.slug,
    appName: app.name,
    currency: app.currency || "USD",
  };

  const isActive = (path: string) => pathname === path;

  return (
    <AppContext.Provider value={appContext}>
      <div className="min-h-screen bg-white">
        <header className="border-b">
          <div className="px-4 md:px-8 py-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-6">
                <div className="relative">
                  <select
                    className={cn(
                      buttonVariants({ variant: "outline", size: "sm" }),
                      "appearance-none text-left pr-8"
                    )}
                    value={slug}
                    onChange={(e) => {
                      const newSlug = e.target.value;
                      if (newSlug === "__manage__") {
                        router.push("/apps");
                      } else {
                        const currentSection = pathname.split("/").pop() || "dashboard";
                        router.push(`/apps/${newSlug}/${currentSection}`);
                      }
                    }}
                  >
                    {allApps.map((a) => (
                      <option key={a._id} value={a.slug}>
                        {a.name}
                      </option>
                    ))}
                    <option value="__manage__">Manage Apps...</option>
                  </select>
                  <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-muted-foreground">
                    <svg className="fill-current h-4 w-4" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">
                      <path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z" />
                    </svg>
                  </div>
                </div>

                <nav className="flex gap-4">
                  <Link
                    href={`/apps/${slug}/dashboard`}
                    className={`px-3 py-2 text-sm font-medium rounded ${
                      isActive(`/apps/${slug}/dashboard`)
                        ? "bg-gray-100 text-black"
                        : "text-gray-600 hover:text-black"
                    }`}
                  >
                    Dashboard
                  </Link>
                  <Link
                    href={`/apps/${slug}/settings`}
                    className={`px-3 py-2 text-sm font-medium rounded ${
                      isActive(`/apps/${slug}/settings`)
                        ? "bg-gray-100 text-black"
                        : "text-gray-600 hover:text-black"
                    }`}
                  >
                    Settings
                  </Link>
                </nav>
              </div>

              <Button onClick={handleSignOut} variant="outline" size="sm">
                Sign out
              </Button>
            </div>
          </div>
        </header>
        <main>{children}</main>
      </div>
    </AppContext.Provider>
  );
}

