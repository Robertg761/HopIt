import type { Metadata } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "@/components/hopit/theme-provider";

export const metadata: Metadata = {
  title: "HopIt — Code & files. Together.",
  description:
    "HopIt is a developer workspace that brings codebases, files, snapshots, and local sync into one collaborative home.",
  keywords: ["HopIt", "developer workspace", "codebase collaboration", "file sync", "workspace snapshots"],
  authors: [{ name: "HopIt Labs" }],
  icons: {
    icon: "/logo.svg",
  },
  openGraph: {
    title: "HopIt — Code & files. Together.",
    description: "Codebases, files, snapshots, and local sync in one collaborative home.",
    siteName: "HopIt",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased bg-background text-foreground">
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          enableSystem={false}
          disableTransitionOnChange
        >
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
