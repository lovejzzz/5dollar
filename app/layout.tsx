import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const candidateHost =
    requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const host = /^[a-z0-9.-]+(?::\d+)?$/i.test(candidateHost)
    ? candidateHost
    : "localhost:3000";
  const forwardedProtocol = requestHeaders.get("x-forwarded-proto");
  const protocol =
    forwardedProtocol === "http" || forwardedProtocol === "https"
      ? forwardedProtocol
      : host.startsWith("localhost")
        ? "http"
        : "https";
  const origin = `${protocol}://${host}`;
  const description =
    "Enter an email and preview how a transparent agent can earn and deliver a $5 digital gift card.";

  return {
    metadataBase: new URL(origin),
    title: {
      default: "FIVE",
      template: "%s · FIVE",
    },
    description,
    openGraph: {
      type: "website",
      title: "FIVE — Your next $5 gift card, handled",
      description,
      images: [
        {
          url: `${origin}/og-gift-card.png`,
          width: 1729,
          height: 910,
          alt: "FIVE — Your next $5 gift card, handled. Sandbox preview.",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "FIVE — Your next $5 gift card, handled",
      description,
      images: [`${origin}/og-gift-card.png`],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        {children}
      </body>
    </html>
  );
}
