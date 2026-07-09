# FIVE

FIVE is a working product preview for a simple promise: enter a payout
destination, click **Get me $5**, and follow an agent from request to payout.

The current build is deliberately a sandbox. It runs the full interface and a
durable D1-backed activity ledger, masks the payout destination, advances the
agent workflow, and can send a browser notification. It does **not** contact a
task marketplace, earn money, or send a payment.

## Product contract

A live version should be inventory-backed, not magical:

1. A sponsor pre-funds an automation-friendly task.
2. The agent matches, completes, and quality-checks that task.
3. Accepted revenue settles.
4. Exactly $5 is released through a supported payout provider.
5. The job is marked paid only after the provider confirms the individual
   payout succeeded.

The agent must never trade, gamble, spam, impersonate someone, require a user
deposit, or automate work whose terms prohibit automation.

## Local development

```bash
npm install
npm run dev
```

The local app uses the D1 binding declared in `.openai/hosting.json`. Tables are
created defensively by the API and are also represented by the checked-in
Drizzle migration.

## Verification

```bash
npm run lint
npm test
```

## What production still needs

- authenticated ownership and one-reward-per-person abuse controls;
- a lawful, funded earning inventory and an idempotent background processor;
- encrypted payout destinations and a keyed fingerprint for deduplication;
- an approved, funded payout provider account and verified webhooks;
- retry, action-needed, failed, and no-inventory states;
- terms, tax, sanctions, fraud, privacy, and worker-classification review.

Zelle is preview-only. It should not be offered as a live self-serve rail
without an approved treasury-bank integration. PayPal is the practical first
provider for a real MVP, subject to business approval and funding.
