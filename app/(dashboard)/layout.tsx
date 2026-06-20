import Link from "next/link";
import AuthGuard from "@/components/shared/AuthGuard";

const NAV = [
  { href: "/leads", label: "🎯 Leads" },
  { href: "/pipeline", label: "🗂️ Pipeline" },
  { href: "/dashboard", label: "📋 Alert Feed" },
  { href: "/explorer", label: "📊 Market Explorer" },
  { href: "/exports", label: "📥 Exports" },
  { href: "/account", label: "⚙️ Account" },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGuard>
      <div className="flex min-h-[calc(100vh-120px)]">
        {/* Desktop sidebar */}
        <aside className="w-56 bg-brand border-r border-gray-800 py-8 px-4 hidden md:flex flex-col gap-2 shrink-0">
          <span className="text-xs font-bold uppercase text-gray-400 tracking-widest mb-3 px-2">Dashboard</span>
          {NAV.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-on-dark hover:bg-[rgba(200,169,108,0.06)] hover:text-accent transition"
            >
              {link.label}
            </Link>
          ))}
        </aside>

        {/* Content + mobile top nav */}
        <div className="flex-1 min-w-0">
          <nav className="md:hidden flex gap-2 overflow-x-auto bg-brand border-b border-gray-800 px-3 py-2 scrollbar-none">
            {NAV.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium text-on-dark hover:text-accent transition shrink-0"
              >
                {link.label}
              </Link>
            ))}
          </nav>
          <div className="py-6 px-4 md:py-8 md:px-6">{children}</div>
        </div>
      </div>
    </AuthGuard>
  );
}
