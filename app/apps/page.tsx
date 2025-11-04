"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { authClient } from "@/lib/auth-client";


export default function AppsPage() {
  const router = useRouter();
  const ensureUserProfile = useMutation(api.auth.ensureUserProfile);
  const [profileReady, setProfileReady] = useState(false);
  const [session, setSession] = useState<any>(null);

  useEffect(() => {
    authClient.getSession().then((result) => {
      if (result.data?.session) {
        setSession(result.data.session);
      } else {
        router.push("/sign-in");
      }
    });
  }, [router]);

  useEffect(() => {
    if (!session) return;
    
    let cancelled = false;

    ensureUserProfile()
      .catch((err) => {
        console.error("Failed to ensure user profile", err);
        if (err.message?.includes("Unauthenticated")) {
          router.push("/sign-in");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setProfileReady(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [ensureUserProfile, session, router]);

  const apps = useQuery(api.apps.getUserApps, profileReady ? undefined : "skip");
  const createApp = useMutation(api.apps.createApp);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [newAppName, setNewAppName] = useState("");
  const [newAppSlug, setNewAppSlug] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  const generateSlug = (name: string) => {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
  };

  const handleNameChange = (name: string) => {
    setNewAppName(name);
    if (!newAppSlug || newAppSlug === generateSlug(newAppName)) {
      setNewAppSlug(generateSlug(name));
    }
  };

  const handleCreateApp = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setError("");

    try {
      const slug = newAppSlug || generateSlug(newAppName);
      await createApp({
        name: newAppName,
        slug,
        currency: "USD",
      });

      setIsCreateDialogOpen(false);
      setNewAppName("");
      setNewAppSlug("");
      router.push(`/apps/${slug}/dashboard`);
    } catch (err: any) {
      setError(err.message || "Failed to create app");
    } finally {
      setCreating(false);
    }
  };

  const handleSignOut = async () => {
    await authClient.signOut();
    router.push("/");
  };

  if (!profileReady || apps === undefined) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white">
        <div>Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white">
      <header className="border-b">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Your Apps</h1>
          <Button onClick={handleSignOut} variant="outline" size="sm">
            Sign out
          </Button>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-4 py-8">
        {apps.length === 0 ? (
          <div className="text-center py-12">
            <h2 className="text-xl font-semibold mb-2">No apps yet</h2>
            <p className="text-gray-600 mb-6">Create your first app to get started</p>
            <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
              <DialogTrigger asChild>
                <Button>Create App</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Create New App</DialogTitle>
                </DialogHeader>
                <form onSubmit={handleCreateApp} className="space-y-4">
                  {error && (
                    <div className="p-3 bg-red-50 border border-red-200 rounded text-red-600 text-sm">
                      {error}
                    </div>
                  )}
                  <div>
                    <label htmlFor="appName" className="block text-sm font-medium mb-1">
                      App Name
                    </label>
                    <Input
                      id="appName"
                      value={newAppName}
                      onChange={(e) => handleNameChange(e.target.value)}
                      placeholder="My Awesome App"
                      required
                    />
                  </div>
                  <div>
                    <label htmlFor="appSlug" className="block text-sm font-medium mb-1">
                      URL Slug
                    </label>
                    <Input
                      id="appSlug"
                      value={newAppSlug}
                      onChange={(e) => setNewAppSlug(e.target.value)}
                      placeholder="my-awesome-app"
                      required
                    />
                    <p className="mt-1 text-xs text-gray-500">
                      This will be used in your app's URL: /apps/{newAppSlug || "my-awesome-app"}
                    </p>
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setIsCreateDialogOpen(false)}
                    >
                      Cancel
                    </Button>
                    <Button type="submit" disabled={creating}>
                      {creating ? "Creating..." : "Create App"}
                    </Button>
                  </div>
                </form>
              </DialogContent>
            </Dialog>
          </div>
        ) : (
          <>
            <div className="flex justify-end mb-6">
              <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
                <DialogTrigger asChild>
                  <Button>Create App</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Create New App</DialogTitle>
                  </DialogHeader>
                  <form onSubmit={handleCreateApp} className="space-y-4">
                    {error && (
                      <div className="p-3 bg-red-50 border border-red-200 rounded text-red-600 text-sm">
                        {error}
                      </div>
                    )}
                    <div>
                      <label htmlFor="appName" className="block text-sm font-medium mb-1">
                        App Name
                      </label>
                      <Input
                        id="appName"
                        value={newAppName}
                        onChange={(e) => handleNameChange(e.target.value)}
                        placeholder="My Awesome App"
                        required
                      />
                    </div>
                    <div>
                      <label htmlFor="appSlug" className="block text-sm font-medium mb-1">
                        URL Slug
                      </label>
                      <Input
                        id="appSlug"
                        value={newAppSlug}
                        onChange={(e) => setNewAppSlug(e.target.value)}
                        placeholder="my-awesome-app"
                        required
                      />
                      <p className="mt-1 text-xs text-gray-500">
                        This will be used in your app's URL: /apps/{newAppSlug || "my-awesome-app"}
                      </p>
                    </div>
                    <div className="flex justify-end gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setIsCreateDialogOpen(false)}
                      >
                        Cancel
                      </Button>
                      <Button type="submit" disabled={creating}>
                        {creating ? "Creating..." : "Create App"}
                      </Button>
                    </div>
                  </form>
                </DialogContent>
              </Dialog>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {apps.map((app) => (
                <Card
                  key={app._id}
                  className="cursor-pointer hover:shadow-md transition-shadow"
                  onClick={() => router.push(`/apps/${app.slug}/dashboard`)}
                >
                  <CardContent className="p-6">
                    <h3 className="text-lg font-semibold mb-2">{app.name}</h3>
                    <p className="text-sm text-gray-600 mb-4">/{app.slug}</p>
                    <div className="text-xs text-gray-500">
                      Created {new Date(app.createdAt).toLocaleDateString()}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

