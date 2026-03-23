export default function HomePage() {
  return (
    <>
      {/* Hero */}
      <section className="relative overflow-hidden py-24 px-6">
        {/* Background images layered */}
        <div className="absolute inset-0 -z-10">
          <picture className="absolute inset-0 w-full h-full">
            <source media="(max-width: 768px)" srcSet="/branding/mobilehero.webp" />
            <img
              src="/branding/pshero.webp"
              alt=""
              aria-hidden="true"
              className="absolute inset-0 w-full h-full object-cover mix-blend-overlay opacity-60"
            />
          </picture>
          {/* semi-transparent overlay to keep text readable */}
          <div className="absolute inset-0 bg-black/60" />
        </div>

        <div className="relative z-10 text-center text-white max-w-2xl mx-auto">
          <h1 className="text-5xl font-bold mb-4 tracking-tight">Know Every New Bar Before Anyone Else</h1>
          <p className="text-xl text-gray-200 mb-8">
            PourScout monitors Texas TABC license filings daily and delivers structured business leads straight to your inbox &mdash; by county, license type, or zip code.
          </p>
          <form className="flex gap-2 justify-center max-w-md mx-auto">
            <input
              type="email"
              placeholder="your@email.com"
              className="flex-1 border border-gray-300 bg-black/30 text-white rounded px-4 py-2 focus:outline-none focus:ring-2 focus:ring-amber-400"
            />
            <button type="submit" className="bg-amber-500 hover:bg-amber-400 text-white font-semibold px-6 py-2 rounded transition">
              Get Early Access
            </button>
          </form>
        </div>
      </section>

      {/* How it works */}
      <section className="py-20 px-6 max-w-5xl mx-auto">
        <h2 className="text-3xl font-bold text-center mb-12 text-[#1a2233]">How It Works</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 text-center">
          <div>
            <div className="text-4xl mb-4">📋</div>
            <h3 className="font-semibold text-lg mb-2">1. TABC Files a License</h3>
            <p className="text-gray-500">Texas TABC posts new license applications daily to the state open data portal.</p>
          </div>
          <div>
            <div className="text-4xl mb-4">⚡</div>
            <h3 className="font-semibold text-lg mb-2">2. We Detect &amp; Enrich It</h3>
            <p className="text-gray-500">We ingest, geocode, and classify every new filing within hours of it appearing.</p>
          </div>
          <div>
            <div className="text-4xl mb-4">📬</div>
            <h3 className="font-semibold text-lg mb-2">3. You Get the Lead</h3>
            <p className="text-gray-500">Receive a daily digest, browse the dashboard, or connect via API or webhook.</p>
          </div>
        </div>
      </section>

      {/* Who it's for */}
      <section className="bg-gray-50 py-20 px-6">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-3xl font-bold text-center mb-12 text-[#1a2233]">Who Uses PourScout</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-6">
            {["Beer &amp; Wine Distributors", "POS Vendors", "Staffing Agencies", "Talent &amp; Booking Agencies", "Insurance Brokers", "Commercial Real Estate"].map((v) => (
              <div key={v} className="bg-white border rounded-lg p-5 text-center shadow-sm">
                <p className="font-medium text-gray-800" dangerouslySetInnerHTML={{ __html: v }} />
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing teaser */}
      <section className="py-20 px-6 text-center">
        <h2 className="text-3xl font-bold mb-4 text-[#1a2233]">Simple, Transparent Pricing</h2>
        <p className="text-gray-500 mb-8">Start free, upgrade when you need more power.</p>
        <a href="/pricing" className="bg-[#1a2233] text-white px-8 py-3 rounded-lg font-semibold hover:bg-blue-900 transition">View Pricing</a>
      </section>
    </>
  );
}
