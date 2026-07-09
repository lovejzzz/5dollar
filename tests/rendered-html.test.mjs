import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
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
  assert.match(app, /What Five will/);
  assert.match(app, /aria-live/);
  assert.match(css, /@media \(max-width: 620px\)/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(hosting, /"d1": "DB"/);
  assert.doesNotMatch(page + layout + app, /codex-preview|Your site is taking shape/i);
});

test("ships the durable job routes and migration", async () => {
  const [createRoute, statusRoute, jobs, migration] = await Promise.all([
    readFile(new URL("app/api/jobs/route.ts", root), "utf8"),
    readFile(new URL("app/api/jobs/[id]/route.ts", root), "utf8"),
    readFile(new URL("lib/jobs.ts", root), "utf8"),
    readFile(new URL("drizzle/0000_square_nocturne.sql", root), "utf8"),
  ]);

  assert.match(createRoute, /export async function POST/);
  assert.match(statusRoute, /export async function GET/);
  assert.match(jobs, /crypto\.subtle\.digest/);
  assert.match(jobs, /maskDestination/);
  assert.match(jobs, /No task or payment was created/);
  assert.match(migration, /CREATE TABLE `jobs`/);
  assert.match(migration, /CREATE TABLE `job_events`/);
  await assert.rejects(access(new URL("app/_sites-preview/SkeletonPreview.tsx", root)));
});
