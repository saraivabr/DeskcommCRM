import "./globals.css";
import type { ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import { Inter, IBM_Plex_Mono } from "next/font/google";

const interfaceFont = Inter({
  subsets: ["latin", "latin-ext"],
  display: "swap",
  variable: "--font-interface",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500"],
  display: "swap",
  variable: "--font-mono",
});

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${interfaceFont.variable} ${plexMono.variable}`}>
      <head />
      <body className={"min-h-screen bg-bg font-sans text-text antialiased"}>{children}</body>
    </html>
  );
}
