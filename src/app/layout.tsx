import type { Metadata } from "next";
import "@/styles/globals.css";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "@/components/providers/theme-provider";
import { ClerkAuthProvider } from "@/components/providers/clerk-auth-provider";
import { shouldEnableClerkUi } from "@/lib/auth-config";

export const metadata: Metadata = {
  title: "HopIt — Your code, on every device",
  description:
    "HopIt is a cloud-native code workspace: codebases live in the cloud, every device stays a thin, synced view of them.",
  keywords: ["HopIt", "developer workspace", "cloud codebase", "file sync", "change sets"],
  authors: [{ name: "HopIt Labs" }],
  icons: {
    icon: "/logo.svg",
  },
  openGraph: {
    title: "HopIt — Your code, on every device",
    description: "Codebases live in the cloud; every device stays a thin, synced view of them.",
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
