import type { Metadata, Viewport } from "next";
import { Bungee, Chakra_Petch } from "next/font/google";

import { AppShell } from "@/components/nav/AppShell";

import "./globals.css";

const bungee = Bungee({ weight: "400", subsets: ["latin"], variable: "--font-bungee", display: "swap" });
const chakra = Chakra_Petch({ weight: ["400", "500", "600", "700"], subsets: ["latin"], variable: "--font-chakra", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Clank RPG — The Global Idle Arena", template: "%s · Clank RPG" },
  description: "Eight heroes. One survivor. The idle arena where the Clank.trade community already has a champion — maybe you.",
  applicationName: "Clank RPG",
  robots: { index: true, follow: true },
};

export const viewport: Viewport = { themeColor: "#07090d", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${bungee.variable} ${chakra.variable}`}>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
