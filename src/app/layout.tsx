import type { Metadata } from "next";
import "@/styles/globals.css";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "@/components/providers/theme-provider";

const siteUrl = new URL(process.env.NEXT_PUBLIC_APP_URL?.trim() || 'https://hopit.dev')

export const metadata: Metadata = {
  metadataBase: siteUrl,
  title: "HopIt",
  description:
    "HopIt is a cloud-native code host: repositories live in the cloud, and every device keeps a synced workspace.",
  keywords: ["HopIt", "code host", "repositories", "pull requests", "issues", "file sync"],
  authors: [{ name: "HopIt Labs" }],
  icons: {
    icon: "/logo.svg",
  },
  alternates: {
    canonical: '/',
  },
  openGraph: {
    title: "HopIt",
    description: "Cloud-native repositories, pull requests, issues, and synced workspaces.",
    siteName: "HopIt",
    type: "website",
    url: '/',
    images: [{ url: '/opengraph-image', width: 1200, height: 630, alt: 'HopIt: Your code, already there' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'HopIt',
    description: 'Cloud-native repositories, pull requests, issues, and synced workspaces.',
    images: ['/opengraph-image'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning data-scroll-behavior="smooth">
      <body>
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          enableSystem={false}
          disableTransitionOnChange
          storageKey="hopit-theme"
        >
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
