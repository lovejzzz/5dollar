import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("defines the complete FIVE product experience", async () => {
  const [page, layout, app, css, hosting] = await Promise.all([
    readFile(new URL("app/page.tsx", root), "utf8"),
    readFile(new URL("app/layout.tsx", root), "utf8"),
    readFile(new URL("app/FiveApp.tsx", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
    readFile(new URL(".openai/hosting.json", root), "utf8"),
  ]);

  assert.match(page, /FIVE — Your next \$5, handled/);
  assert.match(app, /Your next \$5,/);
  assert.match(app, /Get me \$5/);
  assert.match(app, /Where should we send it\?/);
  assert.match(app, /SANDBOX PREVIEW/);
  assert.match(app, /No real money is earned or sent/);
  assert.match(app, /PAYOUT CONFIRMED/);
  assert.match(app, /funded task inventory/i);
  assert.match(app, /What Five will/);
  assert.match(app, /aria-live/);
  assert.match(css, /@media \(max-width: 620px\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(hosting, /"d1": "DB"/);
  assert.doesNotMatch(page + layout + app, /codex-preview|Your site is taking shape/i);
});

test("ships the durable sandbox and live-money routes and migrations", async () => {
  const migrationNames = (await readdir(new URL("drizzle/", root)))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  const migrations = (
    await Promise.all(
      migrationNames.map((name) => readFile(new URL(`drizzle/${name}`, root), "utf8")),
    )
  ).join("\n");
  const [
    createRoute,
    statusRoute,
    jobs,
    processor,
    webhook,
    sponsorPage,
    sponsorCreate,
    sponsorCapture,
    sponsorProcessor,
  ] = await Promise.all([
    readFile(new URL("app/api/jobs/route.ts", root), "utf8"),
    readFile(new URL("app/api/jobs/[id]/route.ts", root), "utf8"),
    readFile(new URL("lib/jobs.ts", root), "utf8"),
    readFile(new URL("lib/process-live-job.ts", root), "utf8"),
    readFile(new URL("app/api/webhooks/paypal/route.ts", root), "utf8"),
    readFile(new URL("app/sponsor/SponsorForm.tsx", root), "utf8"),
    readFile(new URL("app/api/sponsor/orders/route.ts", root), "utf8"),
    readFile(new URL("app/api/sponsor/orders/[id]/capture/route.ts", root), "utf8"),
    readFile(new URL("lib/process-sponsor-order.ts", root), "utf8"),
  ]);

  assert.match(createRoute, /export async function POST/);
  assert.match(statusRoute, /export async function GET/);
  assert.match(jobs, /crypto\.subtle\.digest/);
  assert.match(jobs, /maskDestination/);
  assert.match(jobs, /No task or payment was created/);
  assert.match(migrations, /CREATE TABLE `jobs`/);
  assert.match(migrations, /CREATE TABLE `job_events`/);
  assert.match(migrations, /CREATE TABLE `funded_tasks`/);
  assert.match(migrations, /CREATE TABLE `live_jobs`/);
  assert.match(migrations, /CREATE TABLE `payouts`/);
  assert.match(migrations, /CREATE TABLE `funding_receipts`/);
  assert.match(migrations, /CREATE TABLE `notification_outbox`/);
  assert.match(migrations, /CREATE TABLE `paypal_webhook_events`/);
  assert.match(migrations, /CREATE TABLE `paypal_funding_webhook_events`/);
  assert.match(migrations, /CREATE TABLE `sponsor_task_orders`/);
  assert.match(processor, /earned_cents < 500/);
  assert.match(processor, /createPayPalFiveDollarPayout/);
  assert.match(webhook, /verifyPayPalWebhookSignature/);
  assert.match(webhook, /applyPayPalWebhook/);
  assert.match(sponsorPage, /Continue to PayPal/);
  assert.match(sponsorPage, /rightsAttested/);
  assert.match(sponsorCreate, /prepareSponsorFundingOrder/);
  assert.match(sponsorCapture, /processSponsorCapture/);
  assert.match(sponsorProcessor, /capturePayPalFundingOrder/);
  assert.match(sponsorProcessor, /drainSponsorCaptures/);
  await assert.rejects(access(new URL("app/_sites-preview/SkeletonPreview.tsx", root)));
});
