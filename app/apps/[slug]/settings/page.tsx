"use client";

import { useState, useEffect } from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useApp } from "@/app/apps/[slug]/layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CheckCircle2, XCircle, FolderSearch } from "lucide-react";
import { type RevenueFormat } from "@/app/dashboard/formatters";

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
  const { appId, appName, currency, weekStartDay, useAppStoreRatioForGooglePlay } = useApp();
  const connections = useQuery(api.queries.getPlatformConnections, { appId });
  const userPreferences = useQuery(api.queries.getUserPreferences, { appId });
  const addConnection = useMutation(api.mutations.addPlatformConnection);
  const removeConnection = useMutation(api.mutations.removePlatformConnection);
  const updateCurrency = useMutation(api.mutations.updateAppCurrency);
  const updateApp = useMutation(api.apps.updateApp);
  const updateUserPreferences = useMutation(api.mutations.updateUserPreferences);
  
  const [showForm, setShowForm] = useState<string | null>(null);
  const [selectedCurrency, setSelectedCurrency] = useState(currency);
  const [selectedWeekStartDay, setSelectedWeekStartDay] = useState<"monday" | "sunday">(weekStartDay);
  const [useGooglePlayRatio, setUseGooglePlayRatio] = useState(useAppStoreRatioForGooglePlay);
  const [appNameInput, setAppNameInput] = useState(appName);
  const [isSavingAppName, setIsSavingAppName] = useState(false);
  const [gcsDebugResult, setGcsDebugResult] = useState<any>(null);
  const [isDebuggingGCS, setIsDebuggingGCS] = useState(false);
  const debugGCSBucket = useAction(api.sync.debugGCSBucket);
  const [revenueFormat, setRevenueFormat] = useState<RevenueFormat>("whole");
  const [chartType, setChartType] = useState<"line" | "area">("line");

  useEffect(() => {
    if (currency) {
      setSelectedCurrency(currency);
    }
  }, [currency]);

  useEffect(() => {
    if (userPreferences) {
      setRevenueFormat((userPreferences.revenueFormat as RevenueFormat) ?? "whole");
      setChartType((userPreferences.chartType as "line" | "area") ?? "line");
    }
  }, [userPreferences]);

  useEffect(() => {
    setSelectedWeekStartDay(weekStartDay);
  }, [weekStartDay]);

  useEffect(() => {
    setUseGooglePlayRatio(useAppStoreRatioForGooglePlay);
  }, [useAppStoreRatioForGooglePlay]);

  useEffect(() => {
    setAppNameInput(appName);
  }, [appName]);

  const handleRenameApp = async () => {
    if (appNameInput.trim() && appNameInput !== appName) {
      setIsSavingAppName(true);
      try {
        await updateApp({ appId, name: appNameInput.trim() });
      } finally {
        setIsSavingAppName(false);
      }
    }
  };

  const hasConnection = (platform: string): boolean => {
    return !!connections?.some((c: any) => c.platform === platform);
  };

  const handleCurrencyChange = async (newCurrency: string) => {
    setSelectedCurrency(newCurrency);
    await updateCurrency({ appId, currency: newCurrency });
  };

  const handleWeekStartDayChange = async (newWeekStartDay: "monday" | "sunday") => {
    setSelectedWeekStartDay(newWeekStartDay);
    await updateApp({ appId, weekStartDay: newWeekStartDay });
  };

  const handleGooglePlayRatioChange = async (newValue: boolean) => {
    setUseGooglePlayRatio(newValue);
    await updateApp({ appId, useAppStoreRatioForGooglePlay: newValue });
  };

  const handleRevenueFormatChange = async (checked: boolean) => {
    const newFormat: RevenueFormat = checked ? "twoDecimals" : "whole";
    setRevenueFormat(newFormat);
    await updateUserPreferences({ revenueFormat: newFormat });
  };

  const handleChartTypeChange = async (checked: boolean) => {
    const newType: "line" | "area" = checked ? "area" : "line";
    setChartType(newType);
    await updateUserPreferences({ chartType: newType });
  };

  return (
    <div className="p-4 pt-16">
      <div className="max-w-6xl mx-auto space-y-6">
        <h1 className="text-4xl font-semibold">Settings</h1>

        <Card>
          <CardHeader>
            <CardTitle>App Name</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4 max-w-xs">
              <Input
                type="text"
                value={appNameInput}
                onChange={(e) => setAppNameInput(e.target.value)}
                placeholder="Enter app name"
                className="text-base"
              />
              <Button
                onClick={handleRenameApp}
                disabled={isSavingAppName || !appNameInput.trim() || appNameInput === appName}
              >
                {isSavingAppName ? "Saving..." : "Save"}
              </Button>
            </div>
          </CardContent>
        </Card>

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
            <CardTitle>Revenue Display</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-base text-gray-600 mb-4">
              Choose how revenue numbers are formatted across the dashboard.
            </p>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={revenueFormat === "twoDecimals"}
                onChange={(e) => handleRevenueFormatChange(e.target.checked)}
                className="w-5 h-5 rounded border-gray-300"
              />
              <span className="text-base">
                Show revenue with commas and two decimals (otherwise whole numbers)
              </span>
            </label>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Chart Style</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-base text-gray-600 mb-4">
              Choose the visual style for time series charts in the chat.
            </p>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={chartType === "area"}
                onChange={(e) => handleChartTypeChange(e.target.checked)}
                className="w-5 h-5 rounded border-gray-300"
              />
              <span className="text-base">
                Use area charts instead of line charts
              </span>
            </label>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Week Start Day</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-base text-gray-600 mb-4">
              Choose which day your week starts on. This affects how weekly data is grouped in charts and reports.
            </p>
            <div className="space-y-3">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="radio"
                  name="weekStartDay"
                  value="sunday"
                  checked={selectedWeekStartDay === "sunday"}
                  onChange={(e) => handleWeekStartDayChange(e.target.value as "sunday" | "monday")}
                  className="w-4 h-4"
                />
                <span className="text-base">Sunday</span>
              </label>
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="radio"
                  name="weekStartDay"
                  value="monday"
                  checked={selectedWeekStartDay === "monday"}
                  onChange={(e) => handleWeekStartDayChange(e.target.value as "sunday" | "monday")}
                  className="w-4 h-4"
                />
                <span className="text-base">Monday (recommended)</span>
              </label>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Google Play Plan Split</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-base text-gray-600 mb-4">
              Google Play doesn't provide a breakdown of revenue by plan type (monthly vs yearly). 
              Enable this option to estimate Google Play's split using App Store's historical ratios.
            </p>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={useGooglePlayRatio}
                onChange={(e) => handleGooglePlayRatioChange(e.target.checked)}
                className="w-5 h-5 rounded border-gray-300"
              />
              <span className="text-base">Derive Google Play plan split from App Store</span>
            </label>
            {useGooglePlayRatio && (
              <p className="text-sm text-gray-500 mt-3 ml-8">
                When enabled, Google Play revenue and subscriber data will appear in the monthly/yearly breakdown cards, 
                using the same monthly/yearly ratio as App Store for the corresponding time period.
              </p>
            )}
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
              
              {/* Google Play GCS Debug Section */}
              {hasConnection("googleplay") && (
                <div className="border border-gray-200 rounded p-6 bg-gray-50">
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2 font-semibold text-lg">
                      <FolderSearch className="w-5 h-5 text-gray-600" />
                      Debug: GCS Bucket Contents
                    </div>
                    <button
                      onClick={async () => {
                        setIsDebuggingGCS(true);
                        setGcsDebugResult(null);
                        try {
                          const result = await debugGCSBucket({ appId });
                          setGcsDebugResult(result);
                        } catch (e: any) {
                          setGcsDebugResult({ error: e.message });
                        } finally {
                          setIsDebuggingGCS(false);
                        }
                      }}
                      disabled={isDebuggingGCS}
                      className="px-3 py-1 text-base bg-gray-700 text-white rounded disabled:opacity-50"
                    >
                      {isDebuggingGCS ? "Scanning..." : "Scan Bucket"}
                    </button>
                  </div>
                  
                  {gcsDebugResult && (
                    <div className="text-sm space-y-3">
                      {gcsDebugResult.error ? (
                        <div className="text-red-600 bg-red-50 p-3 rounded border border-red-200">
                          ❌ Error: {gcsDebugResult.error}
                        </div>
                      ) : (
                        <>
                          <div className="bg-white p-3 rounded border">
                            <div className="font-medium mb-2">Bucket Info</div>
                            <div className="font-mono text-xs space-y-1">
                              <div>Bucket: <code className="bg-gray-100 px-1">{gcsDebugResult.bucketName}</code></div>
                              <div>Prefix: <code className="bg-gray-100 px-1">{gcsDebugResult.prefix}</code></div>
                              <div>Package: <code className="bg-gray-100 px-1">{gcsDebugResult.packageName}</code></div>
                              <div>Total files: <strong>{gcsDebugResult.totalFiles}</strong></div>
                              <div>CSV files: <strong>{gcsDebugResult.csvFileCount}</strong></div>
                            </div>
                          </div>

                          {gcsDebugResult.folders?.length > 0 && (
                            <div className="bg-white p-3 rounded border">
                              <div className="font-medium mb-2">📁 Folders Found ({gcsDebugResult.folders.length})</div>
                              <div className="font-mono text-xs max-h-32 overflow-auto">
                                {gcsDebugResult.folders.map((folder: string) => (
                                  <div key={folder} className={folder.includes('earning') ? 'text-green-700 font-bold' : ''}>
                                    {folder.includes('earning') ? '💰 ' : ''}{folder}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {/* Show ALL files in earnings folder for debugging */}
                          <div className="bg-white p-3 rounded border border-yellow-300">
                            <div className="font-medium mb-2 text-yellow-700">
                              📂 All Files in earnings/ folder ({gcsDebugResult.allEarningsFilesCount || 0} total)
                            </div>
                            {gcsDebugResult.allEarningsFiles?.length > 0 ? (
                              <div className="font-mono text-xs max-h-40 overflow-auto space-y-1">
                                {gcsDebugResult.allEarningsFiles.map((file: any) => (
                                  <div key={file.name} className="truncate">
                                    {file.name.endsWith('.csv') ? '✅' : '⚠️'} {file.name} ({Math.round(file.size / 1024)}KB)
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="text-yellow-600 text-sm">
                                ⚠️ The earnings/ folder appears to be empty or inaccessible
                              </div>
                            )}
                          </div>

                          {gcsDebugResult.allSalesFiles?.length > 0 && (
                            <div className="bg-white p-3 rounded border">
                              <div className="font-medium mb-2">📂 All Files in sales/ folder ({gcsDebugResult.allSalesFilesCount})</div>
                              <div className="font-mono text-xs max-h-32 overflow-auto space-y-1">
                                {gcsDebugResult.allSalesFiles.map((file: any) => (
                                  <div key={file.name} className="truncate">
                                    {file.name.endsWith('.csv') ? '✅' : '⚠️'} {file.name} ({Math.round(file.size / 1024)}KB)
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {gcsDebugResult.earningsFiles?.length > 0 && (
                            <div className="bg-white p-3 rounded border border-green-300">
                              <div className="font-medium mb-2 text-green-700">💰 Earnings CSV Files ({gcsDebugResult.earningsFileCount})</div>
                              <div className="font-mono text-xs max-h-32 overflow-auto space-y-1">
                                {gcsDebugResult.earningsFiles.map((file: any) => (
                                  <div key={file.name} className="truncate text-green-800">
                                    {file.name} ({Math.round(file.size / 1024)}KB)
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {gcsDebugResult.salesFiles?.length > 0 && (
                            <div className="bg-white p-3 rounded border">
                              <div className="font-medium mb-2">🛒 Sales Files ({gcsDebugResult.salesFileCount})</div>
                              <div className="font-mono text-xs max-h-24 overflow-auto space-y-1">
                                {gcsDebugResult.salesFiles.map((file: any) => (
                                  <div key={file.name} className="truncate">
                                    {file.name} ({Math.round(file.size / 1024)}KB)
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {gcsDebugResult.sampleCsvFiles?.length > 0 && (
                            <div className="bg-white p-3 rounded border">
                              <div className="font-medium mb-2">📊 Subscription Files (matching package)</div>
                              <div className="font-mono text-xs max-h-32 overflow-auto space-y-1">
                                {gcsDebugResult.sampleCsvFiles.map((file: any) => (
                                  <div key={file.name} className="truncate">
                                    {file.name} ({Math.round(file.size / 1024)}KB)
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {gcsDebugResult.csvFileCount === 0 && (
                            <div className="text-yellow-700 bg-yellow-50 p-3 rounded border border-yellow-200">
                              ⚠️ No CSV files found matching your package name. Check that:
                              <ul className="list-disc ml-5 mt-2">
                                <li>Your package name is correct</li>
                                <li>Reports have been generated (takes time for new apps)</li>
                                <li>The service account has read access to the bucket</li>
                              </ul>
                            </div>
                          )}

                          {gcsDebugResult.folders && !gcsDebugResult.folders.some((f: string) => f.includes('earning')) && (
                            <div className="text-orange-700 bg-orange-50 p-3 rounded border border-orange-200">
                              ⚠️ No <code className="bg-orange-100 px-1">earnings/</code> folder found. 
                              Financial reports may not be exported yet. This is normal for:
                              <ul className="list-disc ml-5 mt-2">
                                <li>New apps without payouts</li>
                                <li>Apps with no recent transactions</li>
                              </ul>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
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
                <h3 className="font-semibold text-base mb-2">How to find your Google Play credentials (2025 method):</h3>
                <ol className="text-sm text-gray-700 space-y-1 list-decimal list-inside">
                  <li>Go to <a href="https://play.google.com/console" target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">play.google.com/console</a> and sign in</li>
                  <li><strong>Package Name:</strong> Go to "App Content" → "App Information", copy your "Package name" (e.g., com.example.app)</li>
                  <li><strong>Find Report Bucket:</strong> Go to "Download reports" → "Financial reports" (or Subscriptions)</li>
                  <li>Click any report and copy the "Direct report URI" (e.g., gs://pubsite_prod_rev_XXXXXXXXXXXX/earnings/earnings_2024_11.csv)</li>
                  <li><strong>Extract Bucket Name:</strong> The bucket name is the part after gs:// and before the first / (e.g., pubsite_prod_rev_XXXXXXXXXXXX)</li>
                  <li>Go to <a href="https://console.cloud.google.com" target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">console.cloud.google.com</a></li>
                  <li>Go to "IAM & Admin" → "Service Accounts"</li>
                  <li>Click "Create Service Account", name it (e.g., "play-reports"), click "Create and Continue"</li>
                  <li>Skip role assignment (we'll add it next), click "Continue" then "Done"</li>
                  <li>Click the created service account → "Keys" tab → "Add Key" → "Create new key" → Select "JSON" → Download</li>
                  <li><strong>Service Account JSON:</strong> Open the downloaded JSON file, copy the entire content (you'll paste it below)</li>
                  <li>Go to "IAM & Admin" → "IAM" (not Service Accounts)</li>
                  <li>Click "Grant Access", paste your service account email (from the JSON: "client_email" field)</li>
                  <li>Grant role: "Storage Object Viewer", click "Save"</li>
                  <li><strong>GCS Bucket Name:</strong> Paste the bucket name you extracted (pubsite_prod_rev_XXXXXXXXXXXX)</li>
                  <li><strong>GCS Report Prefix:</strong> Try "earnings/" first, or leave blank to scan all report types</li>
                </ol>
                <div className="mt-3 p-2 bg-blue-50 border border-blue-200 rounded text-sm">
                  <strong>Note:</strong> Google Play's auto-managed bucket may contain subscription metrics reports in addition to financial reports. We'll attempt to extract all available data including subscriber counts, cancellations, and revenue.
                </div>
              </div>
              <input
                type="text"
                placeholder="Direct Report URI (gs://pubsite_prod_rev_XXX/... - optional helper)"
                value={formData.directReportUri || ""}
                onChange={(e) => {
                  const uri = e.target.value;
                  setFormData({ ...formData, directReportUri: uri });
                  
                  // Auto-parse bucket and prefix if it's a valid gs:// URI
                  const match = uri.match(/^gs:\/\/([^\/]+)\/(.+)/);
                  if (match) {
                    const [, bucket, path] = match;
                    const prefix = path.includes('/') ? path.substring(0, path.lastIndexOf('/') + 1) : '';
                    setFormData({ 
                      ...formData, 
                      directReportUri: uri,
                      gcsBucketName: bucket,
                      gcsReportPrefix: prefix 
                    });
                  }
                }}
                className="w-full px-3 py-2 border border-gray-300 rounded text-base"
              />
              {formData.directReportUri && formData.gcsBucketName && (
                <div className="text-sm text-gray-600 bg-green-50 border border-green-200 rounded p-2">
                  ✓ Parsed: Bucket = <code className="bg-white px-1">{formData.gcsBucketName}</code>
                  {formData.gcsReportPrefix && <>, Prefix = <code className="bg-white px-1">{formData.gcsReportPrefix}</code></>}
                </div>
              )}
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
                placeholder="GCS Bucket Name (e.g. pubsite_prod_rev_XXXXXXXXXXXX)"
                value={formData.gcsBucketName || ""}
                onChange={(e) => {
                  const bucket = e.target.value;
                  setFormData({ ...formData, gcsBucketName: bucket });
                }}
                className="w-full px-3 py-2 border border-gray-300 rounded text-base"
                required
              />
              {formData.gcsBucketName && !formData.gcsBucketName.startsWith('pubsite_prod_rev_') && (
                <div className="text-sm text-yellow-700 bg-yellow-50 border border-yellow-200 rounded p-2">
                  ⚠️ Warning: Bucket name doesn't match the expected Google Play format (pubsite_prod_rev_XXX). Make sure this is correct.
                </div>
              )}
              <input
                type="text"
                placeholder="GCS Report Prefix (try 'earnings/' or leave blank to scan all)"
                value={formData.gcsReportPrefix || ""}
                onChange={(e) =>
                  setFormData({ ...formData, gcsReportPrefix: e.target.value })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded text-base"
              />
              <textarea
                placeholder="Service Account JSON (paste entire JSON content from downloaded file)"
                value={formData.serviceAccountJson || ""}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    serviceAccountJson: e.target.value,
                  })
                }
                className="w-full px-3 py-2 border border-gray-300 rounded text-base font-mono text-xs"
                rows={6}
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
