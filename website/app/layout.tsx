import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

const repositoryUrl =
  process.env.NEXT_PUBLIC_REPOSITORY_URL ??
  "https://github.com/TrendpilotAI/ContactKiller-OSS";

function resolveMetadataBase(): URL {
  const vercelHost =
    process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;
  const configuredUrl =
    process.env.NEXT_PUBLIC_SITE_URL ??
    (vercelHost
      ? `${vercelHost.startsWith("http") ? "" : "https://"}${vercelHost}`
      : undefined);

  if (configuredUrl) {
    try {
      return new URL(configuredUrl);
    } catch {
      // A broken deployment variable must not make the build fail.
    }
  }

  return new URL("http://localhost:3000");
}

export const metadata: Metadata = {
  metadataBase: resolveMetadataBase(),
  title: {
    default: "ContactKiller — Open-source contact reconciliation",
    template: "%s · ContactKiller",
  },
  description:
    "An experimental contact-reconciliation project exploring provenance, replay, and approval gates for fragmented address books.",
  applicationName: "ContactKiller",
  keywords: [
    "contact reconciliation",
    "identity resolution",
    "open source",
    "provenance",
    "ActiveGraph",
    "SurrealDB",
    "FalkorDB",
  ],
  authors: [{ name: "ContactKiller contributors" }],
  creator: "ContactKiller contributors",
  openGraph: {
    type: "website",
    title: "Your address books disagree. ContactKiller shows its work.",
    description:
      "An experimental open-source project exploring provenance, replay, and human-gated contact cleanup.",
    siteName: "ContactKiller",
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "ContactKiller open-source contact reconciliation",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "ContactKiller",
    description:
      "Your address books disagree. ContactKiller shows its work.",
    images: ["/og.png"],
  },
  icons: {
    icon: "/icon.svg",
  },
  alternates: {
    canonical: "/",
  },
  other: {
    "github-repository": repositoryUrl,
  },
};

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#0C0D0E",
};

interface RootLayoutProps {
  children: ReactNode;
}

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="en">
      <body>
        {/*
          THESIS
          ContactKiller makes fragmented identity evidence legible before it makes anything authoritative.

          OWN-WORLD
          A tactile reconciliation bench where source drawers, paper evidence, routed cables, and a locked write gate turn data lineage into a physical system.

          STORY
          Enter through the address-book conflict, trace observations into a conservative identity proposal, inspect the architecture and honest status, then join the open-source work.

          FIRST VIEWPORT
          Editorial challenge copy and cobalt action beside a textless source-to-identity machine with Maya Chen, synthetic person, and an unmistakably locked provider write.

          FORM seed 88b3e66a

          FINISH
          unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
        */}
        {children}
      </body>
    </html>
  );
}
