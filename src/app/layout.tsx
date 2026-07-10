import type { Metadata } from "next";
import "@/styles/globals.css";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "@/components/providers/theme-provider";
import { ClerkAuthProvider } from "@/components/providers/clerk-auth-provider";
import { shouldEnableClerkUi } from "@/lib/auth-config";

export const metadata: Metadata = {
  title: "HopIt",
  description:
    "HopIt is a cloud-native code host: repositories live in the cloud, and every device keeps a synced workspace.",
  keywords: ["HopIt", "code host", "repositories", "pull requests", "issues", "file sync"],
  authors: [{ name: "HopIt Labs" }],
  icons: {
    icon: "/logo.svg",
  },
  openGraph: {
    title: "HopIt",
    description: "Cloud-native repositories, pull requests, issues, and synced workspaces.",
    siteName: "HopIt",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const clerkEnabled = shouldEnableClerkUi();

  return (
    <html lang="en" suppressHydrationWarning data-scroll-behavior="smooth">
      <body>
        <ClerkAuthProvider enabled={clerkEnabled}>
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
        </ClerkAuthProvider>
      </body>
    </html>
  );
}
