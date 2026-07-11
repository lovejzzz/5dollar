"use client";

import {
  FormEvent,
  useEffect,
  useRef,
  useState,
} from "react";

type PayoutMethod = "gift_card" | "paypal" | "zelle" | "cashapp" | "venmo" | "other";
type JobStatus =
  | "received"
  | "matching"
  | "working"
  | "verifying"
  | "payout_preview"
  | "complete";

type JobActivity = {
  step: number;
  title: string;
  detail: string;
  state: "done" | "active" | "pending";
  occurredAt: string | null;
};

type PublicJob = {
  id: string;
  requestCode: string;
  amountCents: 500;
  mode: "sandbox" | "live";
  payoutMethod: PayoutMethod;
  payoutMethodLabel: string;
  destinationHint: string;
  status: JobStatus | string;
  progress: number;
  headline: string;
  message: string;
  payoutReference: string | null;
  createdAt: string;
  completedAt: string | null;
  activities: JobActivity[];
};

type AppConfig = {
  mode: "loading" | "sandbox" | "live";
  liveReady: boolean;
  availableFundedTasks: number;
  rewardProvider: "tremendous" | "paypal";
};

function validateDestination(value: string) {
  const destination = value.trim();
  if (!destination) return "Enter a delivery email.";
  if (destination.length > 120) return "That email address is too long.";

  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return email.test(destination) ? "" : "Enter a valid email address.";
}

function AgentCard({ config }: { config: AppConfig }) {
  const [destination, setDestination] = useState("");
  const [error, setError] = useState("");
  const [signInUrl, setSignInUrl] = useState("");
  const [job, setJob] = useState<PublicJob | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusedJob = useRef<string | null>(null);
  const jobId = job?.id ?? null;
  const jobStatus = job?.status ?? null;

  useEffect(() => {
    if (
      !job ||
      ["complete", "paid", "reversed", "failed", "needs_review"].includes(job.status)
    ) {
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/jobs/${job.id}`, { cache: "no-store" });
        const payload = (await response.json()) as { job?: PublicJob; error?: string };
        if (!response.ok || !payload.job) throw new Error(payload.error || "Status unavailable.");
        if (!cancelled) setJob(payload.job);
      } catch (pollError) {
        if (!cancelled) {
          setError(
            pollError instanceof Error
              ? pollError.message
              : "The latest status could not be loaded.",
          );
        }
      }
    }, job.mode === "live" ? 2_500 : 1_100);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [job]);

  useEffect(() => {
    if (!jobId || !jobStatus) return;
    if (focusedJob.current !== jobId) {
      focusedJob.current = jobId;
      headingRef.current?.focus();
    }
  }, [jobId, jobStatus]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validationError = validateDestination(destination);
    if (validationError) {
      setError(validationError);
      return;
    }

    setSubmitting(true);
    setError("");
    setSignInUrl("");
    try {
      const response = await fetch("/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payoutMethod: "gift_card", destination }),
      });
      const payload = (await response.json()) as {
        job?: PublicJob;
        error?: string;
        signInUrl?: string;
      };
      if (!response.ok || !payload.job) {
        setSignInUrl(
          response.status === 401 &&
            typeof payload.signInUrl === "string" &&
            /^\/signin-with-chatgpt(?:\?|$)/.test(payload.signInUrl)
            ? payload.signInUrl
            : "",
        );
        throw new Error(payload.error || "The demo could not be started.");
      }
      setJob(payload.job);
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : "The demo could not be started.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  function resetDemo() {
    setJob(null);
    setDestination("");
    setError("");
    setSignInUrl("");
    focusedJob.current = null;
  }

  if (job) {
    const complete = job.status === "complete" || job.status === "paid";
    const live = job.mode === "live";
    const needsAction = ["needs_action", "needs_review", "reversed", "failed"].includes(
      job.status,
    );
    return (
      <section className="request-card request-card--running" aria-labelledby="job-heading">
        <div className="card-status-row">
          <span className={`agent-state ${complete ? "agent-state--done" : ""}`}>
            <span className="agent-state__dot" aria-hidden="true" />
            {complete ? (live ? "GIFT CARD DELIVERED" : "DEMO FINISHED") : needsAction ? "ACTION NEEDED" : "AGENT RUNNING"}
          </span>
          <span className="request-code">{job.requestCode}</span>
        </div>

        <div className="job-heading-wrap" aria-live={complete ? "assertive" : "polite"}>
          <h2 id="job-heading" ref={headingRef} tabIndex={-1}>
            {job.headline}
          </h2>
          <p>{job.message}</p>
        </div>

        <div className="job-destination">
          <div>
            <span className="job-destination__amount">$5.00</span>
            <span className="job-destination__label">{live ? "live reward" : "sandbox reward"}</span>
          </div>
          <p>
            {job.payoutMethodLabel} <span aria-hidden="true">·</span>{" "}
            <strong>{job.destinationHint}</strong>
          </p>
        </div>

        <div
          className="progress-track"
          role="progressbar"
          aria-label={live ? "Live reward workflow progress" : "Demo workflow progress"}
          aria-valuenow={job.progress}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span style={{ width: `${job.progress}%` }} />
        </div>

        <ol className="activity-list" aria-label="Agent activity">
          {job.activities.map((activity) => (
            <li
              key={activity.step}
              className={`activity activity--${activity.state}`}
              aria-current={activity.state === "active" ? "step" : undefined}
            >
              <span className="activity__marker" aria-hidden="true">
                {activity.state === "done" ? "✓" : activity.step + 1}
              </span>
              <div>
                <strong>{activity.title}</strong>
                <span>{activity.detail}</span>
              </div>
            </li>
          ))}
        </ol>

        <div className={`demo-disclosure ${complete ? "demo-disclosure--complete" : ""} ${live ? "demo-disclosure--live" : ""}`}>
          <span className="demo-disclosure__label">
            {live
              ? complete
                ? job.payoutMethod === "gift_card"
                  ? "EMAIL DELIVERED"
                  : "PAYPAL CONFIRMED"
                : needsAction
                  ? "ACTION NEEDED"
                  : "LIVE WORKFLOW"
              : complete
                ? "NO FUNDS MOVED"
                : "DEMO MODE"}
          </span>
          <p>
            {live
              ? complete
                ? job.payoutMethod === "gift_card"
                  ? "The mail server accepted the email containing a fresh provider-hosted redemption link."
                  : "The individual payout item—not just its batch—was reported successful by PayPal."
                : "Live rewards use pre-funded tasks and pre-issued gift cards. Delivery starts only after the work is accepted."
              : complete
                ? "This preview stored only a masked email and simulated the workflow."
                : "These steps are simulated. No marketplace task or gift card is being created."}
          </p>
        </div>

        <button className="secondary-button" type="button" onClick={resetDemo}>
          {complete ? (live ? "Back to the request form" : "Run the demo again") : live ? "Back to the request form" : "Cancel demo"}
        </button>
      </section>
    );
  }

  const liveSetupPaused = config.mode === "live" && !config.liveReady;
  const noLiveInventory =
    config.mode === "live" &&
    config.liveReady &&
    config.availableFundedTasks <= 0;
  const liveRequestDisabled = liveSetupPaused || noLiveInventory;

  return (
    <section className="request-card" aria-labelledby="request-heading">
      <div className="card-status-row">
        <span className="mono-label">YOUR GIFT CARD</span>
        <span className="fixed-pill">FIXED AMOUNT</span>
      </div>
      <h2 id="request-heading" className="amount-lockup" aria-label="Five U.S. dollars">
        <span className="amount-lockup__currency">$</span>
        <span className="amount-lockup__number">5.00</span>
        <span className="amount-lockup__code">USD</span>
      </h2>

      <form onSubmit={handleSubmit} noValidate>
        <div className="payout-rail" aria-label="Reward method: digital gift card">
          <span>DIGITAL GIFT CARD</span>
          <strong>Delivered by email</strong>
        </div>

        <div className="field-group">
          <label htmlFor="payout-destination">Email for delivery</label>
          <input
            id="payout-destination"
            name="payout-destination"
            value={destination}
            onChange={(event) => {
              setDestination(event.target.value);
              if (error) setError("");
              if (signInUrl) setSignInUrl("");
            }}
            onBlur={() => destination && setError(validateDestination(destination))}
            placeholder="you@example.com"
            autoComplete="email"
            spellCheck={false}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "destination-error" : "destination-help"}
          />
          {error ? (
            <>
              <p className="field-error" id="destination-error" role="alert">
                {error}
              </p>
              {signInUrl && (
                <a className="sign-in-action" href={signInUrl}>
                  Sign in with ChatGPT to continue
                  <span aria-hidden="true">→</span>
                </a>
              )}
            </>
          ) : (
            <p className="field-help" id="destination-help">
              {config.mode === "live"
                ? "We send a fresh provider-hosted redemption link to this address after the task is accepted."
                : "This sandbox shows the full flow but does not issue or send a real gift card."}
            </p>
          )}
        </div>

        <button
          className={`primary-button ${liveRequestDisabled ? "primary-button--unavailable" : ""}`}
          type="submit"
          disabled={submitting || liveRequestDisabled}
          aria-describedby={noLiveInventory ? "live-inventory-note" : undefined}
        >
          <span>
            {submitting
              ? "Starting the agent…"
              : noLiveInventory
                ? "No funded tasks available"
                : liveSetupPaused
                  ? "Live requests paused"
                  : "Get me a $5 gift card"}
          </span>
          <span aria-hidden="true">→</span>
        </button>
        {noLiveInventory && (
          <p className="live-inventory-note" id="live-inventory-note" role="status">
            Live requests reopen when a sponsor-funded task is ready.
          </p>
        )}
      </form>

      <p className="card-assurance">
        <span className="assurance-mark" aria-hidden="true">✓</span>
        No password. No card. No upfront payment. Delivery status stays visible.
      </p>
    </section>
  );
}

export function FiveApp() {
  const [config, setConfig] = useState<AppConfig>({
    mode: "loading",
    liveReady: false,
    availableFundedTasks: 0,
    rewardProvider: "tremendous",
  });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/config", { cache: "no-store" })
      .then(async (response) => {
        const payload = (await response.json()) as Partial<AppConfig>;
        if (!cancelled) {
          setConfig({
            mode: payload.mode === "live" ? "live" : "sandbox",
            liveReady: payload.liveReady === true,
            availableFundedTasks:
              typeof payload.availableFundedTasks === "number"
                ? payload.availableFundedTasks
                : 0,
            rewardProvider: payload.rewardProvider === "paypal" ? "paypal" : "tremendous",
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setConfig({
            mode: "sandbox",
            liveReady: false,
            availableFundedTasks: 0,
            rewardProvider: "tremendous",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const live = config.mode === "live";
  return (
    <>
      <div className="sandbox-strip" role="note">
        <strong>
          {config.mode === "loading"
            ? "CHECKING STATUS"
            : live
              ? config.liveReady
                ? "LIVE BETA"
                : "LIVE SETUP PAUSED"
              : "SANDBOX PREVIEW"}
        </strong>
        <span aria-hidden="true">·</span>
        {config.mode === "loading"
          ? "Confirming whether this deployment is sandbox or live."
          : live
            ? config.liveReady
              ? `${config.availableFundedTasks} funded task${config.availableFundedTasks === 1 ? "" : "s"} currently available. Payment is confirmed only after provider success.`
              : "Live requests are disabled until every earning and payout secret is configured."
            : "This demo simulates the workflow. No real task or gift card is created."}
      </div>

      <header className="site-header">
        <a className="brand" href="#top" aria-label="FIVE home">
          <span className="brand-mark" aria-hidden="true">5</span>
          <span>FIVE</span>
        </a>
        <nav aria-label="Main navigation">
          <a href="#how-it-works">How it works</a>
          <a href="#safety">Safety</a>
        </nav>
        <span className="demo-pill"><span aria-hidden="true" /> {live ? "LIVE BETA" : "DEMO MODE"}</span>
      </header>

      <main id="top">
        <section className="hero" aria-labelledby="hero-heading">
          <div className="hero-copy">
            <p className="eyebrow">AUTONOMOUS MICRO-EARNING AGENT</p>
            <h1 id="hero-heading">
              Your next $5 gift card,
              <span>handled.</span>
            </h1>
            <p className="hero-lede">
              Give Five an email. The agent matches approved, pre-funded work,
              completes the task, and delivers a $5 digital gift card.
            </p>
            <div className="proof-row" aria-label="Product promises">
              <span><i aria-hidden="true" />No card needed</span>
              <span><i aria-hidden="true" />One fixed reward</span>
              <span><i aria-hidden="true" />Every step visible</span>
            </div>
            <p className="hero-qualifier">
              {live
                ? "Live requests depend on pre-funded task inventory and verified gift-card delivery."
                : "Prototype experience. The gift-card provider is not connected to production yet."}
            </p>
            <div className="five-watermark" aria-hidden="true">$5</div>
          </div>
          <AgentCard config={config} />
        </section>

        <section className="how-section" id="how-it-works" aria-labelledby="how-heading">
          <p className="section-kicker">ONE REQUEST. THREE CLEAR STEPS.</p>
          <h2 id="how-heading">Simple for you. Accountable underneath.</h2>
          <div className="step-grid">
            <article>
              <span className="step-number">01</span>
              <h3>Give us an email</h3>
              <p>Enter the address that should receive the $5 digital gift card.</p>
            </article>
            <article>
              <span className="step-number">02</span>
              <h3>Five gets to work</h3>
              <p>The agent matches an approved, funded opportunity and completes the work.</p>
            </article>
            <article>
              <span className="step-number">03</span>
              <h3>Redeem your $5</h3>
              <p>After the work is accepted, Five emails a fresh provider-hosted redemption link.</p>
            </article>
          </div>
        </section>

        <section className="safety-panel" id="safety" aria-labelledby="safety-heading">
          <div className="safety-copy">
            <p className="section-kicker section-kicker--light">BUILT AROUND PROOF</p>
            <h2 id="safety-heading">What Five will—and won’t—do.</h2>
            <p className="safety-lede">A money-making agent should be boringly transparent.</p>
            <ul className="safety-rules">
              <li>
                <span aria-hidden="true">01</span>
                <div><strong>Approved work only</strong><p>No spam, impersonation, gambling, or prohibited tasks.</p></div>
              </li>
              <li>
                <span aria-hidden="true">02</span>
                <div><strong>No spending your money</strong><p>Five never needs a deposit, purchase, password, or card.</p></div>
              </li>
              <li>
                <span aria-hidden="true">03</span>
                <div><strong>A visible receipt</strong><p>Every job state and real delivery update must be logged.</p></div>
              </li>
            </ul>
          </div>

          <aside
            className="receipt"
            aria-label={live ? "Live gift-card contract" : "Simulated agent receipt"}
          >
            <div className="receipt__top">
              <span>AGENT RECEIPT</span>
              <span className="receipt__stamp">{live ? "LIVE CONTRACT" : "SIMULATED"}</span>
            </div>
            <div className="receipt__amount"><span>$</span>5.00</div>
            <dl>
              <div><dt>Opportunity</dt><dd>Approved sponsor task</dd></div>
              <div><dt>Agent work</dt><dd>Completed + checked</dd></div>
              <div><dt>Reward</dt><dd>Pre-issued at $5</dd></div>
              <div><dt>Delivery</dt><dd>Email receipt required</dd></div>
            </dl>
            <div className="receipt__footer">
              <span>{live ? "FIVE / LIVE BETA" : "FIVE / DEMO"}</span>
              <span>{live ? "PROVIDER PROOF REQUIRED" : "NOT A PAYMENT"}</span>
            </div>
          </aside>
        </section>

        <section className="faq-section" aria-labelledby="faq-heading">
          <div>
            <p className="section-kicker">THE HONEST DETAILS</p>
            <h2 id="faq-heading">Before you ask.</h2>
          </div>
          <div className="faq-list">
            <details open>
              <summary>Where does the $5 come from?</summary>
              <p>
                {live
                  ? "Each approved task is paired with a pre-issued $5 gift card. The agent completes one and releases its redemption link only after the evidence contract accepts the work."
                  : "In a live version, each approved task is paired with a pre-issued $5 gift card. The agent completes one, quality-checks it, and releases the link only after acceptance."}
              </p>
            </details>
            <details>
              <summary>Is the $5 guaranteed?</summary>
              <p>
                Not unless a funded reward is already reserved. A real product must show inventory,
                eligibility, and timing before accepting a request. Some card choices may also be limited by country.
              </p>
            </details>
            <details>
              <summary>What data does Five store?</summary>
              <p>
                {live
                  ? "Live requests store the authenticated owner email, an encrypted delivery email, a keyed fingerprint, a masked hint, provider IDs, and notification state. Redemption links are generated only when an email is sent and are never stored by Five."
                  : "The demo saves a one-way hash and a masked email—not the raw address—plus the workflow status needed to keep the activity log consistent."}
              </p>
            </details>
          </div>
        </section>
      </main>

      <footer>
        <a className="brand brand--footer" href="#top" aria-label="Back to top">
          <span className="brand-mark" aria-hidden="true">5</span>
          <span>FIVE</span>
        </a>
        <p>A transparent experiment in autonomous earning.</p>
        <span>© 2026 FIVE LABS</span>
      </footer>
    </>
  );
}
