"use client";

import { useApp } from "../layout";

export default function HistoryPage() {
  const { appName } = useApp();

  return (
    <div className="p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-2xl font-semibold mb-4">History - {appName}</h1>
        <p className="text-gray-600">Historical metrics data will be displayed here.</p>
      </div>
    </div>
  );
}

