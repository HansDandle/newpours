import Link from 'next/link';

interface Tier {
  name: string;
  price: string;
  included: string[];
  locked: string[];
  cta: string;
  href: string;
  highlight: boolean;
  badge: string | null;
}

const tiers: Tier[] = [
  {
    name: 'Free',
    price: '$0',
    included: [
      'Weekly digest — new establishments every Monday',
      '2-county filter',
      'Revenue & comptroller data (2 counties)',
      '25 CSV exports/mo',
      '1 seat',
    ],
    locked: [
      'Immediate new bar alerts',
      'All 254 Texas counties',
      'Health inspection records',
      'Building permit data',
      'API access',
    ],
    cta: 'Get Started Free',
    href: '/signup?plan=free',
    highlight: false,
    badge: null,
  },
  {
    name: 'Pro',
    price: '$49',
    included: [
      'Immediate new bar alerts (daily)',
      'All 254 Texas counties',
      'Revenue & comptroller data — all counties',
      'Health inspection records',
      'Building permit data',
      'Unlimited CSV exports',
      'API access (read-only)',
      '3 seats',
    ],
    locked: [],
    cta: 'Start Free Pro Trial',
    href: '/signup?plan=pro',
    highlight: true,
    badge: 'Beta: Free for 90 days — then $49/mo',
  },
  {
    name: 'Enterprise',
    price: '$199',
    included: [
      'Everything in Pro',
      'Real-time webhook feed',
      'Unlimited seats',
      'Dedicated onboarding',
      'Custom data integrations',
      'Priority support',
    ],
    locked: [],
    cta: 'Contact Sales',
    href: 'mailto:hello@pourscout.com',
    highlight: false,
    badge: null,
  },
];

export default function PricingPage() {
  return (
    <section className="max-w-5xl mx-auto py-20 px-6">
      <h1 className="text-4xl font-bold text-center mb-4 text-on-light">Pricing</h1>
      <p className="text-center text-gray-500 mb-4">No contracts. Cancel anytime.</p>
      <p className="text-center text-sm font-semibold accent mb-12">
        Limited beta: Pro is free for your first 3 months — no credit card required.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-8 items-start">
        {tiers.map((tier) => (
          <div
            key={tier.name}
            className={`rounded-xl border p-8 flex flex-col ${
              tier.highlight
                ? 'border-[var(--brand-accent)] bg-[rgba(200,169,108,0.06)] shadow-lg md:scale-105'
                : 'border-gray-200 bg-white'
            }`}
          >
            {tier.badge && (
              <span className="text-xs font-bold uppercase tracking-widest accent mb-2">
                {tier.badge}
              </span>
            )}
            <h2 className="text-2xl font-bold mb-1 text-on-light">{tier.name}</h2>
            {tier.highlight ? (
              <div className="mb-6">
                <p className="text-4xl font-bold">
                  <span className="line-through text-gray-400 text-2xl mr-2">$49</span>
                  <span className="accent">$0</span>
                  <span className="text-base font-normal text-gray-400">/mo for 90 days</span>
                </p>
                <p className="text-xs text-gray-500 mt-1">then $49/mo — cancel anytime</p>
              </div>
            ) : (
              <p className="text-4xl font-bold mb-6">
                {tier.price}
                <span className="text-base font-normal text-gray-400">/mo</span>
              </p>
            )}
            <ul className="mb-4 flex-1 space-y-2">
              {tier.included.map((f) => (
                <li key={f} className="flex items-start gap-2 text-gray-700 text-sm">
                  <span className="text-green-500 mt-0.5 shrink-0">✓</span> {f}
                </li>
              ))}
              {tier.locked.map((f) => (
                <li key={f} className="flex items-start gap-2 text-gray-300 text-sm">
                  <span className="mt-0.5 shrink-0">✕</span>
                  <span className="line-through">{f}</span>
                </li>
              ))}
            </ul>
            <Link
              href={tier.href}
              className={`w-full py-3 rounded-lg font-semibold transition text-center block mt-4 ${
                tier.highlight
                  ? 'btn-accent hover:brightness-95'
                  : 'border border-gray-300 text-gray-700 hover:border-[var(--brand-accent)] hover:text-[var(--brand-accent)]'
              }`}
            >
              {tier.cta}
            </Link>
          </div>
        ))}
      </div>
    </section>
  );
}
