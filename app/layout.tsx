import type { Metadata } from 'next';
import "../styles/globals.css";
import Navbar from "../components/shared/Navbar";
import Footer from "../components/shared/Footer";
import { AuthProvider } from "../components/shared/AuthProvider";

export const metadata: Metadata = {
  title: 'PourScout — TABC License Alerts',
  description: 'Real-time TABC license alerts for Texas vendors.',
  icons: {
    icon: '/branding/pourscout_sm_logo.png',
    apple: '/branding/pourscout_sm_logo.png',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen flex flex-col bg-white text-gray-900">
        <AuthProvider>
          <Navbar />
          <main className="flex-1">{children}</main>
          <Footer />
        </AuthProvider>
      </body>
    </html>
  );
}
