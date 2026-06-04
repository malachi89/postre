import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Postre",
  description: "Local personal HTTP client"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
