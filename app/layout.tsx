import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SMS-påminnelser",
  description: "Klinik-återbokning via BokaDirekt-import och automatiska SMS-påminnelser"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="sv">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Merriweather:wght@700;900&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
