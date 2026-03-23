import AdminGuard from "@/components/shared/AdminGuard";
import Link from "next/link";

const NAV_ITEMS = [
  { href: "/admin", label: "Overview", icon: "📊" },
  { href: "/admin/establishments", label: "Establishments", icon: "🏢" },
  { href: "/admin/queues/unmatched", label: "Unmatched Records", icon: "⚠️" },
  { href: "/admin/queues/duplicates", label: "Duplicate Flags", icon: "🔁" },
  { href: "/admin/users", label: "Users & Billing", icon: "👥" },
  { href: "/admin/jobs", label: "Job Monitor", icon: "⚙️" },
  { href: "/admin/logs", label: "Logs", icon: "📋" },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <AdminGuard>
      <div className="flex min-h-screen bg-gray-950 text-gray-100">
        {/* Sidebar */}
        <aside className="w-52 shrink-0 bg-gray-900 border-r border-gray-800 flex flex-col py-6">
          <div className="px-4 mb-6">
            <span className="text-xs font-bold uppercase tracking-widest text-gray-500">
              Admin
            </span>
            <p className="text-sm font-semibold text-amber-400 mt-1">NewPours</p>
          </div>
          <nav className="flex flex-col gap-0.5 px-2">
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="flex items-center gap-2 px-3 py-2 rounded text-sm text-gray-300 hover:bg-gray-800 hover:text-white transition"
              >
                <span className="text-base">{item.icon}</span>
                {item.label}
              </Link>
            ))}
          </nav>
        </aside>

        {/* Content */}
        <div className="flex-1 min-w-0 overflow-auto">{children}</div>
      </div>
    </AdminGuard>
  );
}
