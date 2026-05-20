import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Audena Calls",
  description: "Trigger automated voice calls.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
