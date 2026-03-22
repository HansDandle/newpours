import Link from "next/link";
import AuthGuard from "@/components/shared/AuthGuard";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGuard>
    <div className="flex min-h-[calc(100vh-120px)]">
      {/* Sidebar */}
      <aside className="w-56 bg-gray-50 border-r border-gray-200 py-8 px-4 hidden md:flex flex-col gap-2 shrink-0">
        <span className="text-xs font-bold uppercase text-gray-400 tracking-widest mb-3 px-2">Dashboard</span>
        <Link href="/dashboard" className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-gray-700 hover:bg-amber-50 hover:text-amber-600 transition">
          📋 Alert Feed
        </Link>
        <Link href="/exports" className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-gray-700 hover:bg-amber-50 hover:text-amber-600 transition">
          📥 Exports
        </Link>
        <Link href="/account" className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-gray-700 hover:bg-amber-50 hover:text-amber-600 transition">
          ⚙️ Account
        </Link>
      </aside>
      {/* Content */}
      <div className="flex-1 py-8 px-6">{children}</div>
    </div>
    </AuthGuard>
  );
}
