import type { Metadata } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "@/components/hopit/theme-provider";
import { ClerkAuthProvider } from "@/components/hopit/clerk-auth-provider";
import { isClerkPublicConfigured } from "@/lib/auth-config";

export const metadata: Metadata = {
  title: "HopIt — Code & files. Together.",
  description:
    "HopIt is a developer workspace that brings codebases, active change sets, files, and local sync into one collaborative home.",
  keywords: ["HopIt", "developer workspace", "codebase collaboration", "file sync", "active change sets"],
  authors: [{ name: "HopIt Labs" }],
  icons: {
    icon: "/logo.svg",
  },
  openGraph: {
    title: "HopIt — Code & files. Together.",
    description: "Codebases, active change sets, files, and local sync in one collaborative home.",
    siteName: "HopIt",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const clerkEnabled = isClerkPublicConfigured();

  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased bg-background text-foreground">
        <ClerkAuthProvider enabled={clerkEnabled}>
          <ThemeProvider
            attribute="class"
            defaultTheme="light"
            enableSystem={false}
            disableTransitionOnChange
          >
            {children}
            <Toaster />
          </ThemeProvider>
        </ClerkAuthProvider>
      </body>
    </html>
  );
}
