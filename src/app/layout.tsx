import type { Metadata } from "next";
import "@/website/styles/globals.css";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "@/website/components/theme-provider";
import { ClerkAuthProvider } from "@/website/components/clerk-auth-provider";
import { shouldEnableClerkUi } from "@/lib/auth-config";

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
  const clerkEnabled = shouldEnableClerkUi();

  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased bg-background text-foreground">
        <ClerkAuthProvider enabled={clerkEnabled}>
          <ThemeProvider
            attribute="class"
            defaultTheme="dark"
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
