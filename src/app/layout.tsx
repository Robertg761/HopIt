import type { Metadata } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "@/components/hopit/theme-provider";

export const metadata: Metadata = {
  title: "HopIt — Code & files. Together.",
  description:
    "HopIt is a developer workspace that brings Git repositories and a shared file drive into one collaborative home.",
  keywords: ["HopIt", "GitHub alternative", "Google Drive for code", "developer workspace", "code collaboration"],
  authors: [{ name: "HopIt Labs" }],
  icons: {
    icon: "/logo.svg",
  },
  openGraph: {
    title: "HopIt — Code & files. Together.",
    description: "Git repositories and a shared file drive, in one collaborative home.",
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
