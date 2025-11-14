import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { ConvexClientProvider } from "./ConvexClientProvider";

const haffer = localFont({
  src: [
    { path: "../public/fonts/Haffer-VF.woff2", style: "normal" },
  ],
  variable: "--font-haffer",
  display: "swap",
  weight: "100 900",
});

const hafferMono = localFont({
  src: [
    { path: "../public/fonts/HafferMono-TRIAL-Regular.woff2", weight: "400", style: "normal" },
    { path: "../public/fonts/HafferMono-TRIAL-Medium.woff2", weight: "500", style: "normal" },
  ],
  variable: "--font-haffer-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Metry",
  description: "Subscription analytics platform",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${haffer.variable} ${hafferMono.variable} antialiased`}>
        <ConvexClientProvider>{children}</ConvexClientProvider>
      </body>
    </html>
  );
}
