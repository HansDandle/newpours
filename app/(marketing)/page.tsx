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
          {/* lighter semi-transparent overlay to keep text readable */}
          <div className="absolute inset-0 bg-black/60" />
        </div>

        <div className="relative z-10 text-center max-w-2xl mx-auto bg-brand px-8 py-12 rounded-lg">
          <h1 className="text-4xl md:text-5xl font-semibold mb-4 tracking-tight text-white">Your competition doesn't know about this yet.</h1>
          <p className="text-lg md:text-xl text-white mb-8">
            PourScout turns every new Texas TABC filing into a verified lead, filtered to your territory, ready to act on.
            <br />
            For distributors, POS vendors, staffing agencies, and insurers who sell to the on-premise market.
          </p>
          <div className="flex justify-center mt-6 mb-4">
            <img
              src="/branding/lgpslogo.svg"
              alt="PourScout logo"
              className="h-40 md:h-56 lg:h-72 w-auto"
            />
          </div>
          <div className="flex flex-col sm:flex-row gap-3 justify-center mt-6">
            <a
              href="/signup?plan=pro"
              className="btn-accent px-7 py-3 rounded-lg font-semibold transition text-center"
            >
              Get Pro Free for 3 Months
            </a>
            <a
              href="/signup"
              className="px-7 py-3 rounded-lg font-semibold transition text-center border border-white text-white hover:bg-white/10"
            >
              Start Free
            </a>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="py-20 px-6 max-w-5xl mx-auto">
        <h2 className="text-3xl font-bold text-center mb-12 text-on-light">How It Works</h2>
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
          <h2 className="text-3xl font-bold text-center mb-12 text-on-light">Who Uses PourScout</h2>
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
        <h2 className="text-3xl font-bold mb-4 text-on-light">Simple, Transparent Pricing</h2>
        <p className="text-gray-500 mb-2">Start free, upgrade when you need more power.</p>
        <p className="text-sm font-semibold accent mb-8">Limited beta — Pro free for 3 months, then $49/mo.</p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <a href="/signup?plan=pro" className="btn-accent px-8 py-3 rounded-lg font-semibold transition">Claim Free Pro Trial</a>
          <a href="/pricing" className="px-8 py-3 rounded-lg font-semibold transition border border-gray-300 text-gray-700 hover:border-[var(--brand-accent)] hover:text-[var(--brand-accent)]">View All Plans</a>
        </div>
      </section>
    </>
  );
}
