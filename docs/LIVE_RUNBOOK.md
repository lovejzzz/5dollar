# FIVE gift-card live-mode runbook

The public promise is simple; activation is intentionally strict. The currently
deployed app stays private and in sandbox until every gate below is complete.

## 1. Establish the real economic loop

FIVE does not create money. Before a task can be claimed, the operator must pay
for one `$5.00 USD` digital reward and bind it to one approved task. Model,
email, provider, and operating costs are separate from the claimant's full $5.

The first task contract is intentionally narrow:

- `dataset_summary` only;
- the sponsor or operator owns the input and explicitly permits automation;
- every required evidence ID is supplied in the input and must appear in the
  agent's structured submission;
- automatic acceptance is deterministic;
- no spam, impersonation, fake reviews, gambling, financial trading,
  purchases, credentials, ad manipulation, harassment, political
  manipulation, or private-data collection.

## 2. Obtain a production gift-card provider account

FIVE's first reward provider is Tremendous. Use Test Flight for integration,
then request production API access from the Tremendous dashboard. Production
approval is an external account gate; Tremendous may request company and
banking documentation. Do not enter invented information and do not assume a
gift-card API is an SSN bypass.

Record these values outside the repository:

```text
TREMENDOUS_API_KEY
TREMENDOUS_CAMPAIGN_ID
TREMENDOUS_FUNDING_SOURCE_ID   # optional; balance is the default
```

The campaign must support a link-delivery reward with a `$5.00 USD`
denomination. Fund the production balance before creating inventory.

Provider references:

- https://developers.tremendous.com/docs/sandbox-environment
- https://developers.tremendous.com/docs/production-api-access
- https://developers.tremendous.com/docs/link-delivery

## 3. Configure AI and transactional email

Create an OpenAI API project for bounded task execution. The adapter has no
tools and requires a fixed submission schema.

Use the verified `five.nexttask.team` Resend domain and configure a monitored
support mailbox. Register this webhook endpoint:

```text
https://five-production-relay.xingpicture.workers.dev/webhooks/resend
```

Subscribe to `email.delivered`, `email.delivery_delayed`, `email.bounced`,
`email.failed`, and `email.suppressed`. FIVE verifies the raw Svix signature,
deduplicates events, and stores no recipient address from provider webhooks.

## 4. Configure hosted values

Generate independent, unpadded base64url 32-byte encryption and fingerprint
keys. Never reuse them.

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Configure these through Sites, never in Git:

```text
FIVE_MODE=sandbox
REWARD_PROVIDER=tremendous
TREMENDOUS_MODE=sandbox
PAYOUT_ENCRYPTION_KEY
PAYOUT_FINGERPRINT_KEY
PROCESSOR_SECRET
TASK_ADMIN_SECRET
OPENAI_API_KEY
OPENAI_MODEL=gpt-5.4-mini
TREMENDOUS_API_KEY
TREMENDOUS_CAMPAIGN_ID
TREMENDOUS_FUNDING_SOURCE_ID
RESEND_API_KEY
RESEND_WEBHOOK_SECRET
NOTIFICATION_FROM_EMAIL=Five <rewards@five.nexttask.team>
SUPPORT_EMAIL=<monitored mailbox>
```

Leave all provider base-URL overrides empty in production. They work only with
`PROVIDER_TEST_MODE=loopback` and a loopback host.

## 5. Apply the D1 migrations

Back up the target database and apply every migration in `drizzle/` in order.
Verify `gift_card_rewards` exists with unique order and reward indexes and a
foreign key to `funded_tasks`. Keep the previous sandbox deployment as the
rollback path. Never hand-edit a reward row to force progress.

## 6. Keep the private relay healthy

The claimant app remains owner-only during the canary. The checked-in Worker at
`five-production-relay.xingpicture.workers.dev` forwards the raw Resend webhook
through the Sites access boundary and calls the private recovery drain once per
minute.

Its secrets are:

```text
SITES_BYPASS_TOKEN=<current private-site bypass token>
PROCESSOR_SECRET=<same value as the FIVE site>
```

The processor drains agent jobs and notification rows with leases and bounded
retries. Sponsor PayPal capture reconciliation is skipped when the active
reward provider is Tremendous.

## 7. Create one test inventory item

The operator endpoint first asks Tremendous to create the reward, verifies the
returned exact `$5.00 USD` executed order, and only then inserts the task:

```text
POST /api/internal/tasks
Authorization: Bearer <TASK_ADMIN_SECRET>
Content-Type: application/json

{
  "taskType": "dataset_summary",
  "title": "Summarize supplied product feedback",
  "instructions": "Using only the supplied rows, produce a concise theme summary and list the supporting row identifiers.",
  "input": {"rows":[{"id":"r1","feedback":"The setup was fast."}]},
  "rewardCents": 500,
  "sponsorReference": "sponsor:gift:001",
  "automationAllowed": true,
  "autoAccept": true,
  "acceptance": {"requiredEvidenceIds":["r1"],"minEvidenceCount":1},
  "minAnswerChars": 120
}
```

`sponsorReference` is the stable provider `external_id`, so a retry cannot buy a
second reward. The database stores the order ID and reward ID, never the
redemption link.

## 8. Run the sandbox and production canaries

In Test Flight, verify:

- a duplicate operator request returns the same task/reward binding;
- the user must sign in and can submit only a valid delivery email;
- one identity and one email fingerprint cannot claim twice;
- the agent uses only approved input and the acceptance contract is enforced;
- link generation happens only while sending the notification;
- a Resend `delivered` event changes the job, reward, and delivery ledger to
  their terminal success states exactly once;
- bounced, failed, and suppressed events move the job to `needs_action`;
- logs and D1 contain no raw redemption link or provider secret.

Repeat the same checks with one low-risk `$5` production reward while the site
is still private. Confirm the card can actually be redeemed in the intended
country. Mail-server acceptance proves delivery of the email, not redemption by
the person, so support and reissue policy must be explicit.

## 9. Activate live mode last

Only after provider approval, funding, truthful account verification, legal/tax
review, fraud controls, database migration, and a successful production canary:

```text
FIVE_MODE=live
REWARD_PROVIDER=tremendous
TREMENDOUS_MODE=live
```

Live runtime rejects non-production Tremendous keys. Before broadening access,
confirm the hosting edge owns the authenticated-user header and add suitable
rate limits/Sybil controls. The database uniqueness rules are a backstop, not
identity proof.

## PayPal adapter status

The prior PayPal Checkout/Payouts implementation remains covered by regression
tests but is inactive in the gift-card product. It can be selected only with a
fully approved PayPal business setup and `REWARD_PROVIDER=paypal`; it is not a
fallback when Tremendous production approval is absent.
