const tiers = [
  {
    name: 'Basic',
    price: '$49',
    features: ['Daily alerts', 'County filter', '100 CSV exports/mo', '1 seat'],
    cta: 'Start Basic',
    highlight: false,
  },
  {
    name: 'Pro',
    price: '$199',
    features: ['All filters', 'Unlimited exports', 'API access (read-only)', '3 seats'],
    cta: 'Start Pro',
    highlight: true,
  },
  {
    name: 'Enterprise',
    price: '$599',
    features: ['Real-time feed', 'Webhooks', 'Unlimited seats', 'Priority support'],
    cta: 'Contact Sales',
    highlight: false,
  },
];

export default function PricingPage() {
  return (
    <section className="max-w-5xl mx-auto py-20 px-6">
      <h1 className="text-4xl font-bold text-center mb-4 text-[#1a2233]">Pricing</h1>
      <p className="text-center text-gray-500 mb-12">No contracts. Cancel anytime.</p>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
        {tiers.map((tier) => (
          <div
            key={tier.name}
            className={`rounded-xl border p-8 flex flex-col ${
              tier.highlight
                ? 'border-amber-400 bg-amber-50 shadow-lg scale-105'
                : 'border-gray-200 bg-white'
            }`}
          >
            {tier.highlight && (
              <span className="text-xs font-bold uppercase tracking-widest text-amber-500 mb-2">Most Popular</span>
            )}
            <h2 className="text-2xl font-bold mb-1 text-[#1a2233]">{tier.name}</h2>
            <p className="text-4xl font-bold mb-6">{tier.price}<span className="text-base font-normal text-gray-400">/mo</span></p>
            <ul className="mb-8 flex-1 space-y-2">
              {tier.features.map((f) => (
                <li key={f} className="flex items-center gap-2 text-gray-700">
                  <span className="text-green-500">✓</span> {f}
                </li>
              ))}
            </ul>
            <button
              className={`w-full py-3 rounded-lg font-semibold transition ${
                tier.highlight
                  ? 'bg-amber-500 hover:bg-amber-400 text-white'
                  : 'bg-[#1a2233] hover:bg-blue-800 text-white'
              }`}
            >
              {tier.cta}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
