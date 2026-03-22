# NewPours — Next.js 14+ SaaS
# See TABC_ALERT_SPEC.md for full requirements

## Getting Started

1. Install dependencies:
   npm install

2. Set up your .env.local file (see .env.example)

3. To run the Next.js app locally:
   npm run dev

4. To run Firebase Functions locally:
   cd functions
   npm install
   npm run build
   firebase emulators:start

## Project Structure

- app/           # Next.js App Router
- components/    # UI components
- lib/           # Shared libraries (Firebase, Stripe, etc.)
- functions/     # Firebase Cloud Functions (TypeScript)
- types/         # Shared TypeScript types

## Useful Scripts

- npm run dev         # Start Next.js dev server
- npm run build       # Build Next.js app
- npm run lint        # Lint code
- npm run format      # Format code with Prettier

- cd functions        # Enter Cloud Functions folder
- npm run build       # Build functions
- firebase deploy     # Deploy functions to Firebase
