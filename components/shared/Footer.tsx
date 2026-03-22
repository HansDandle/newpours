export default function Footer() {
  return (
    <footer className="w-full py-6 px-8 bg-[#1a2233] text-gray-400 text-sm">
      <div className="max-w-5xl mx-auto flex flex-col md:flex-row justify-between items-center gap-4">
        <span className="text-amber-400 font-bold">NewPours</span>
        <span>&copy; 2026 NewPours. All rights reserved.</span>
        <div className="flex gap-6">
          <a href="/pricing" className="hover:text-white transition">Pricing</a>
          <a href="/login" className="hover:text-white transition">Sign In</a>
        </div>
      </div>
    </footer>
  );
}
