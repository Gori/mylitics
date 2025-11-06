"use client";

import { useState, useEffect } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useApp } from "@/app/apps/[slug]/layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckCircle2, XCircle } from "lucide-react";

const CURRENCIES = [
  { code: "USD", name: "US Dollar", symbol: "$" },
  { code: "EUR", name: "Euro", symbol: "€" },
  { code: "GBP", name: "British Pound", symbol: "£" },
  { code: "JPY", name: "Japanese Yen", symbol: "¥" },
  { code: "CAD", name: "Canadian Dollar", symbol: "C$" },
  { code: "AUD", name: "Australian Dollar", symbol: "A$" },
  { code: "CHF", name: "Swiss Franc", symbol: "CHF" },
  { code: "CNY", name: "Chinese Yuan", symbol: "¥" },
  { code: "INR", name: "Indian Rupee", symbol: "₹" },
  { code: "BRL", name: "Brazilian Real", symbol: "R$" },
  { code: "SEK", name: "Swedish Krona", symbol: "kr" },
  { code: "NOK", name: "Norwegian Krone", symbol: "kr" },
  { code: "DKK", name: "Danish Krone", symbol: "kr" },
  { code: "NZD", name: "New Zealand Dollar", symbol: "NZ$" },
  { code: "SGD", name: "Singapore Dollar", symbol: "S$" },
  { code: "HKD", name: "Hong Kong Dollar", symbol: "HK$" },
  { code: "KRW", name: "South Korean Won", symbol: "₩" },
  { code: "MXN", name: "Mexican Peso", symbol: "Mex$" },
  { code: "ZAR", name: "South African Rand", symbol: "R" },
  { code: "TRY", name: "Turkish Lira", symbol: "₺" },
  { code: "PLN", name: "Polish Zloty", symbol: "zł" },
];

export default function SettingsPage() {
  const { appId, appName, currency } = useApp();
  const connections = useQuery(api.queries.getPlatformConnections, { appId });
  const addConnection = useMutation(api.mutations.addPlatformConnection);
  const removeConnection = useMutation(api.mutations.removePlatformConnection);
  const updateCurrency = useMutation(api.mutations.updateAppCurrency);
  
  const [showForm, setShowForm] = useState<string | null>(null);
  const [selectedCurrency, setSelectedCurrency] = useState(currency);

  useEffect(() => {
    if (currency) {
      setSelectedCurrency(currency);
    }
  }, [currency]);

  const hasConnection = (platform: string): boolean => {
    return !!connections?.some((c: any) => c.platform === platform);
  };

  const handleCurrencyChange = async (newCurrency: string) => {
    setSelectedCurrency(newCurrency);
    await updateCurrency({ appId, currency: newCurrency });
  };

  return (
    <div className="p-4 md:p-8">
      <div className="max-w-6xl mx-auto space-y-6">
        <h1 className="text-4xl font-semibold">Settings - {appName}</h1>

        <Card>
          <CardHeader>
            <CardTitle>Currency</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-base text-gray-600 mb-4">
              Select your preferred currency. All revenue data will be converted to this currency.
            </p>
            <div className="max-w-xs">
              <label className="block text-base font-medium mb-2">
                Preferred Currency
              </label>
              <select
                value={selectedCurrency}
                onChange={(e) => handleCurrencyChange(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded text-base"
              >
                {CURRENCIES.map((curr) => (
                  <option key={curr.code} value={curr.code}>
                    {curr.symbol} {curr.code} - {curr.name}
                  </option>
                ))}
              </select>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Platform Connections</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-6">
              <PlatformSection
                platform="stripe"
                label="Stripe"
                appId={appId}
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
                appId={appId}
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
                appId={appId}
                hasConnection={hasConnection("googleplay")}
                connections={connections}
                showForm={showForm}
                setShowForm={setShowForm}
                addConnection={addConnection}
                removeConnection={removeConnection}
              />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function PlatformSection({
  platform,
  label,
  appId,
  hasConnection,
  connections,
  showForm,
  setShowForm,
  addConnection,
  removeConnection,
}: {
  platform: string;
  label: string;
  appId: any;
  hasConnection: boolean;
  connections: any;
  showForm: string | null;
  setShowForm: (platform: string | null) => void;
  addConnection: any;
  removeConnection: any;
}) {
  const [formData, setFormData] = useState<Record<string, string>>({});

  useEffect(() => {
    if (showForm === platform) {
      if (connections && Array.isArray(connections)) {
        const connection = connections.find((c: any) => c.platform === platform);
        if (connection?.credentials) {
          try {
            const creds = JSON.parse(connection.credentials);
            setFormData(creds);
          } catch (e) {
            console.error("Failed to parse credentials:", e);
            setFormData({});
          }
        } else if (hasConnection) {
          // Connection exists but no credentials loaded yet - keep existing formData
        } else {
          setFormData({});
        }
      } else if (!hasConnection) {
        // No connection and no connections data - clear form
        setFormData({});
      }
    } else {
      setFormData({});
    }
  }, [showForm, platform, hasConnection, connections]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await addConnection({
      appId,
      platform: platform as any,
      credentials: JSON.stringify(formData),
    });
    setShowForm(null);
    setFormData({});
  };

  const handleRemove = async () => {
    const connection = connections?.find((c: any) => c.platform === platform);
    if (connection) {
      await removeConnection({ appId, connectionId: connection._id });
    }
  };

  const handleShowForm = () => {
    // Populate form data synchronously before opening form
    if (hasConnection && connections && Array.isArray(connections)) {
      const connection = connections.find((c: any) => c.platform === platform);
      if (connection?.credentials && connection.credentials.trim()) {
        try {
          const creds = JSON.parse(connection.credentials);
          setFormData(creds);
        } catch (e) {
          console.error("Failed to parse credentials:", e);
          setFormData({});
        }
      } else {
        setFormData({});
      }
    } else {
      setFormData({});
    }
    setShowForm(platform);
  };

  return (
    <div className="border border-gray-200 rounded p-6">
      <div className="flex justify-between items-center mb-4">
        <div className="flex items-center gap-2 font-semibold text-lg">
          {hasConnection ? (
            <CheckCircle2 className="w-5 h-5 text-green-600" />
          ) : (
            <XCircle className="w-5 h-5 text-red-600" />
          )}
          {label}
        </div>
        {hasConnection ? (
          <div className="flex gap-2">
            <button
              onClick={handleShowForm}
              className="px-3 py-1 text-base border border-gray-300 rounded"
            >
              Update
            </button>
            <button
              onClick={handleRemove}
              className="px-3 py-1 text-base border border-gray-300 rounded text-red-600"
            >
              Remove
            </button>
          </div>
        ) : (
          <button
            onClick={handleShowForm}
            className="px-3 py-1 text-base bg-black text-white rounded"
          >
            Connect
          </button>
        )}
      </div>

      {showForm === platform && (
        <form onSubmit={handleSubmit} className="space-y-3">
          {platform === "stripe" && (
            <>
              <div className="bg-gray-50 border border-gray-200 rounded p-4 mb-4">
                <h3 className="font-semibold text-base mb-2">How to find your API Key:</h3>
                <ol className="text-sm text-gray-700 space-y-1 list-decimal list-inside">
                  <li>Go to <a href="https://dashboard.stripe.com" target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">dashboard.stripe.com</a> and sign in</li>
                  <li>Click "Developers" in the top menu</li>
                  <li>Click "API keys" in the left sidebar</li>
                  <li>Copy your "Secret key" (starts with sk_live_ or sk_test_)</li>
                  <li>Paste it in the field below</li>
                </ol>
              </div>
              <input
                type="text"
                placeholder="API Key"
                value={formData.apiKey || ""}
                onChange={(e) =>
                  setFormData({ ...formData, apiKey: e.target.value })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded text-base"
                required
              />
            </>
          )}
          {platform === "appstore" && (
            <>
              <div className="bg-gray-50 border border-gray-200 rounded p-4 mb-4">
                <h3 className="font-semibold text-base mb-2">How to find your App Store credentials:</h3>
                <ol className="text-sm text-gray-700 space-y-1 list-decimal list-inside">
                  <li>Go to <a href="https://appstoreconnect.apple.com" target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">appstoreconnect.apple.com</a> and sign in</li>
                  <li>Click "Users and Access" → "Keys"</li>
                  <li>Click "+" to create a new key, select "App Manager" role</li>
                  <li><strong>Key ID:</strong> Copy the "Key ID" shown after creation</li>
                  <li><strong>Issuer ID:</strong> Copy the "Issuer ID" shown at the top of the Keys page</li>
                  <li><strong>Private Key:</strong> Download the .p8 file and open it in a text editor, copy the entire content</li>
                  <li>Go to "App Information" → select your app</li>
                  <li><strong>Bundle ID:</strong> Copy the "Bundle ID"</li>
                  <li>Go to "Sales and Trends" → "View Sales Reports"</li>
                  <li><strong>Vendor Number:</strong> Copy the "Vendor Number" shown in the URL or footer</li>
                </ol>
              </div>
              <input
                type="text"
                placeholder="Issuer ID"
                value={formData.issuerId || ""}
                onChange={(e) =>
                  setFormData({ ...formData, issuerId: e.target.value })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded text-base"
                required
              />
              <input
                type="text"
                placeholder="Key ID"
                value={formData.keyId || ""}
                onChange={(e) =>
                  setFormData({ ...formData, keyId: e.target.value })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded text-base"
                required
              />
              <input
                type="text"
                placeholder="Bundle ID"
                value={formData.bundleId || ""}
                onChange={(e) =>
                  setFormData({ ...formData, bundleId: e.target.value })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded text-base"
                required
              />
              <input
                type="text"
                placeholder="Vendor Number (e.g. 12345678)"
                value={formData.vendorNumber || ""}
                onChange={(e) =>
                  setFormData({ ...formData, vendorNumber: e.target.value })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded text-base"
                required
              />
              <textarea
                placeholder="Private Key (PEM format)"
                value={formData.privateKey || ""}
                onChange={(e) =>
                  setFormData({ ...formData, privateKey: e.target.value })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded text-base"
                rows={4}
                required
              />
            </>
          )}
          {platform === "googleplay" && (
            <>
              <div className="bg-gray-50 border border-gray-200 rounded p-4 mb-4">
                <h3 className="font-semibold text-base mb-2">How to find your Google Play credentials:</h3>
                <ol className="text-sm text-gray-700 space-y-1 list-decimal list-inside">
                  <li>Go to <a href="https://play.google.com/console" target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">play.google.com/console</a> and sign in</li>
                  <li><strong>Package Name:</strong> Go to "App Content" → "App Information", copy your "Package name" (e.g., com.example.app)</li>
                  <li>Go to <a href="https://console.cloud.google.com" target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">console.cloud.google.com</a></li>
                  <li>Create or select a project</li>
                  <li>Go to "IAM & Admin" → "Service Accounts"</li>
                  <li>Click "Create Service Account", name it (e.g., "play-reports"), click "Create and Continue"</li>
                  <li>Grant role: "Storage Object Viewer", click "Continue" then "Done"</li>
                  <li>Click the created service account → "Keys" tab → "Add Key" → "Create new key" → Select "JSON" → Download</li>
                  <li><strong>Service Account JSON:</strong> Open the downloaded JSON file, copy the entire content</li>
                  <li>Go to "Cloud Storage" → "Buckets" → "Create Bucket"</li>
                  <li>Name your bucket (e.g., my-app-play-reports), choose location, click "Create"</li>
                  <li><strong>GCS Bucket Name:</strong> Copy the bucket name</li>
                  <li>Go back to Play Console → "Settings" → "Cloud Storage"</li>
                  <li>Link your GCS bucket, enable "Earnings" report export</li>
                  <li><strong>GCS Report Prefix:</strong> Usually "earnings/" (leave blank to use default)</li>
                </ol>
              </div>
              <input
                type="text"
                placeholder="Package Name (e.g. com.example.app)"
                value={formData.packageName || ""}
                onChange={(e) =>
                  setFormData({ ...formData, packageName: e.target.value })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded text-base"
                required
              />
              <input
                type="text"
                placeholder="GCS Bucket Name (e.g. my-app-play-reports)"
                value={formData.gcsBucketName || ""}
                onChange={(e) =>
                  setFormData({ ...formData, gcsBucketName: e.target.value })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded text-base"
                required
              />
              <input
                type="text"
                placeholder="GCS Report Prefix (default: earnings/)"
                value={formData.gcsReportPrefix || ""}
                onChange={(e) =>
                  setFormData({ ...formData, gcsReportPrefix: e.target.value })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded text-base"
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
                className="w-full px-3 py-2 border border-gray-300 rounded text-base"
                rows={4}
                required
              />
            </>
          )}
          <div className="flex gap-2">
            <button
              type="submit"
              className="px-4 py-2 bg-black text-white rounded text-base"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setShowForm(null);
                setFormData({});
              }}
              className="px-4 py-2 border border-gray-300 rounded text-base"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
