"use client";

import { useQuery, useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useUser } from "@clerk/nextjs";

export default function ConnectionsPage() {
  const { isSignedIn, isLoaded } = useUser();
  const router = useRouter();
  const connections = useQuery(api.queries.getPlatformConnections);
  const addConnection = useMutation(api.mutations.addPlatformConnection);
  const removeConnection = useMutation(api.mutations.removePlatformConnection);

  const [showForm, setShowForm] = useState<string | null>(null);

  useEffect(() => {
    if (isLoaded && !isSignedIn) {
      router.replace("/sign-in");
    }
  }, [isLoaded, isSignedIn, router]);

  if (!isLoaded || !isSignedIn) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white">
        <div>Loading...</div>
      </div>
    );
  }

  const hasConnection = (platform: string): boolean => {
    return !!connections?.some((c: any) => c.platform === platform);
  };

  return (
    <div className="min-h-screen bg-white p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        <button
          onClick={() => router.push("/dashboard")}
          className="mb-8 text-sm text-gray-600"
        >
          ← Back
        </button>

        <div className="space-y-6">
          <PlatformSection
            platform="stripe"
            label="Stripe"
            hasConnection={hasConnection("stripe")}
            connections={connections}
            showForm={showForm}
            setShowForm={setShowForm}
            addConnection={addConnection}
            removeConnection={removeConnection}
          />
          <PlatformSection
            platform="appstore"
            label="App Store"
            hasConnection={hasConnection("appstore")}
            connections={connections}
            showForm={showForm}
            setShowForm={setShowForm}
            addConnection={addConnection}
            removeConnection={removeConnection}
          />
          <PlatformSection
            platform="googleplay"
            label="Google Play"
            hasConnection={hasConnection("googleplay")}
            connections={connections}
            showForm={showForm}
            setShowForm={setShowForm}
            addConnection={addConnection}
            removeConnection={removeConnection}
          />
        </div>
      </div>
    </div>
  );
}

function PlatformSection({
  platform,
  label,
  hasConnection,
  connections,
  showForm,
  setShowForm,
  addConnection,
  removeConnection,
}: {
  platform: string;
  label: string;
  hasConnection: boolean;
  connections: any;
  showForm: string | null;
  setShowForm: (platform: string | null) => void;
  addConnection: any;
  removeConnection: any;
}) {
  const [formData, setFormData] = useState<Record<string, string>>({});

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await addConnection({
      platform: platform as any,
      credentials: JSON.stringify(formData),
    });
    setShowForm(null);
    setFormData({});
  };

  const handleRemove = async () => {
    const connection = connections?.find((c: any) => c.platform === platform);
    if (connection) {
      await removeConnection({ connectionId: connection._id });
    }
  };

  return (
    <div className="border border-gray-200 rounded p-6">
      <div className="flex justify-between items-center mb-4">
        <div className="font-semibold">{label}</div>
        {hasConnection ? (
          <div className="flex gap-2">
            <button
              onClick={() => setShowForm(platform)}
              className="px-3 py-1 text-sm border border-gray-300 rounded"
            >
              Update
            </button>
            <button
              onClick={handleRemove}
              className="px-3 py-1 text-sm border border-gray-300 rounded text-red-600"
            >
              Remove
            </button>
          </div>
        ) : (
          <button
            onClick={() => setShowForm(platform)}
            className="px-3 py-1 text-sm bg-black text-white rounded"
          >
            Connect
          </button>
        )}
      </div>

      {showForm === platform && (
        <form onSubmit={handleSubmit} className="space-y-3">
          {platform === "stripe" && (
            <input
              type="text"
              placeholder="API Key"
              value={formData.apiKey || ""}
              onChange={(e) =>
                setFormData({ ...formData, apiKey: e.target.value })
              }
              className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
              required
            />
          )}
          {platform === "appstore" && (
            <>
              <input
                type="text"
                placeholder="Issuer ID"
                value={formData.issuerId || ""}
                onChange={(e) =>
                  setFormData({ ...formData, issuerId: e.target.value })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
                required
              />
              <input
                type="text"
                placeholder="Key ID"
                value={formData.keyId || ""}
                onChange={(e) =>
                  setFormData({ ...formData, keyId: e.target.value })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
                required
              />
              <input
                type="text"
                placeholder="Bundle ID"
                value={formData.bundleId || ""}
                onChange={(e) =>
                  setFormData({ ...formData, bundleId: e.target.value })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
                required
              />
              <input
                type="text"
                placeholder="Vendor Number (e.g. 12345678)"
                value={formData.vendorNumber || ""}
                onChange={(e) =>
                  setFormData({ ...formData, vendorNumber: e.target.value })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
                required
              />
              <textarea
                placeholder="Private Key (PEM format)"
                value={formData.privateKey || ""}
                onChange={(e) =>
                  setFormData({ ...formData, privateKey: e.target.value })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
                rows={4}
                required
              />
            </>
          )}
          {platform === "googleplay" && (
            <>
              <input
                type="text"
                placeholder="Package Name"
                value={formData.packageName || ""}
                onChange={(e) =>
                  setFormData({ ...formData, packageName: e.target.value })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
                required
              />
              <textarea
                placeholder="Service Account JSON"
                value={formData.serviceAccountJson || ""}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    serviceAccountJson: e.target.value,
                  })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded text-sm"
                rows={4}
                required
              />
            </>
          )}
          <div className="flex gap-2">
            <button
              type="submit"
              className="px-4 py-2 bg-black text-white rounded text-sm"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setShowForm(null);
                setFormData({});
              }}
              className="px-4 py-2 border border-gray-300 rounded text-sm"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

