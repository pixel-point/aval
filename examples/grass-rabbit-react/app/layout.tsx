import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "Grass Rabbit · AVAL for React",
  description:
    "A focused Next.js example for rendering authored AVAL interaction through useAval()."
};

export const viewport: Viewport = {
  colorScheme: "light",
  themeColor: "#f2efe7"
};

interface RootLayoutProps {
  readonly children: ReactNode;
}

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
