"use client";

import {
  FormEvent,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

type PayoutMethod = "paypal" | "zelle" | "cashapp" | "venmo" | "other";
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
  payoutMethods: PayoutMethod[];
  availableFundedTasks: number;
};

const METHOD_OPTIONS: Array<{
  value: PayoutMethod;
  label: string;
  availability: string;
}> = [
  { value: "paypal", label: "PayPal", availability: "planned live rail" },
  { value: "zelle", label: "Zelle", availability: "preview only" },
  { value: "cashapp", label: "Cash App", availability: "preview only" },
  { value: "venmo", label: "Venmo", availability: "preview only" },
  { value: "other", label: "Other", availability: "preview only" },
];

const PLACEHOLDERS: Record<PayoutMethod, string> = {
  paypal: "Email, phone, or PayPal ID",
  zelle: "Email or U.S. mobile number",
  cashapp: "$cashtag",
  venmo: "@username",
  other: "Payout address or handle",
};

const METHOD_HELP: Record<PayoutMethod, string> = {
  paypal: "A live version would use a PayPal-linked email, phone, or PayPal ID.",
  zelle: "Shown for product preview only; a live Zelle rail is not connected.",
  cashapp: "Shown for product preview only; a live Cash App rail is not connected.",
  venmo: "Shown for product preview only; a live Venmo rail is not connected.",
  other: "Shown for product preview only; no generic payout rail is connected.",
};

function subscribeToBrowserCapabilities() {
  return () => undefined;
}

function validateDestination(method: PayoutMethod, value: string) {
  const destination = value.trim();
  if (!destination) return "Enter a payout destination.";
  if (destination.length > 120) return "That payout destination is too long.";

  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const phone = /^\+?[\d\s().-]{7,22}$/;
  const handle = /^@?[a-zA-Z0-9._-]{2,40}$/;
  const valid =
    method === "paypal"
      ? email.test(destination) || phone.test(destination) || handle.test(destination)
      : method === "zelle"
        ? email.test(destination) || phone.test(destination)
        : method === "cashapp"
          ? /^\$[a-zA-Z][a-zA-Z0-9_]{1,19}$/.test(destination)
          : method === "venmo"
            ? handle.test(destination)
            : destination.length >= 3;
  return valid ? "" : "Check that destination and try again.";
}

function AgentCard({ config }: { config: AppConfig }) {
  const [method, setMethod] = useState<PayoutMethod>("paypal");
  const [destination, setDestination] = useState("");
  const [error, setError] = useState("");
  const [signInUrl, setSignInUrl] = useState("");
  const [job, setJob] = useState<PublicJob | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [notifyBrowser, setNotifyBrowser] = useState(false);
  const notificationsAvailable = useSyncExternalStore(
    subscribeToBrowserCapabilities,
    () => "Notification" in window,
    () => false,
  );
  const headingRef = useRef<HTMLHeadingElement>(null);
  const notifiedJob = useRef<string | null>(null);
  const focusedJob = useRef<string | null>(null);
  const jobId = job?.id ?? null;
  const jobStatus = job?.status ?? null;
  const jobMode = job?.mode ?? null;

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
    if (
      (jobStatus === "complete" || jobStatus === "paid") &&
      notifiedJob.current !== jobId &&
      notifyBrowser &&
      "Notification" in window &&
      Notification.permission === "granted"
    ) {
      notifiedJob.current = jobId;
      new Notification(jobMode === "live" ? "Your $5 has arrived" : "FIVE demo complete", {
        body:
          jobMode === "live"
            ? "PayPal confirmed that your individual $5 payout succeeded."
            : "The preview finished. No real task or payment was created.",
      });
    }
  }, [jobId, jobMode, jobStatus, notifyBrowser]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validationError = validateDestination(method, destination);
    if (validationError) {
      setError(validationError);
      return;
    }

    setSubmitting(true);
    setError("");
    setSignInUrl("");
    try {
      if (
        notifyBrowser &&
        notificationsAvailable &&
        Notification.permission === "default"
      ) {
        await Notification.requestPermission();
      }
      const response = await fetch("/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payoutMethod: method, destination }),
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
      notifiedJob.current = null;
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
    notifiedJob.current = null;
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
            {complete ? (live ? "PAYOUT CONFIRMED" : "DEMO FINISHED") : needsAction ? "ACTION NEEDED" : "AGENT RUNNING"}
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
                ? "PAYPAL CONFIRMED"
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
                ? "The individual payout item—not just its batch—was reported successful by PayPal."
                : "Live rewards use pre-funded tasks. A payout cannot start until accepted revenue covers the full $5."
              : complete
                ? "This preview stored only a masked destination and simulated the workflow."
                : "These steps are simulated. No marketplace task or payout is being created."}
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
        <span className="mono-label">YOUR PAYOUT</span>
        <span className="fixed-pill">FIXED AMOUNT</span>
      </div>
      <h2 id="request-heading" className="amount-lockup" aria-label="Five U.S. dollars">
        <span className="amount-lockup__currency">$</span>
        <span className="amount-lockup__number">5.00</span>
        <span className="amount-lockup__code">USD</span>
      </h2>

      <form onSubmit={handleSubmit} noValidate>
        <div className="field-group">
          <label htmlFor="payout-method">Payout method</label>
          <div className="select-wrap">
            <select
              id="payout-method"
              value={method}
              onChange={(event) => {
                setMethod(event.target.value as PayoutMethod);
                setError("");
                setSignInUrl("");
              }}
            >
              {METHOD_OPTIONS.filter(
                (option) => config.mode !== "live" || option.value === "paypal",
              ).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label} —{
                    config.mode === "live" && option.value === "paypal"
                      ? " live rail"
                      : ` ${option.availability}`
                  }
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="field-group">
          <label htmlFor="payout-destination">Where should we send it?</label>
          <input
            id="payout-destination"
            name="payout-destination"
            value={destination}
            onChange={(event) => {
              setDestination(event.target.value);
              if (error) setError("");
              if (signInUrl) setSignInUrl("");
            }}
            onBlur={() => destination && setError(validateDestination(method, destination))}
            placeholder={PLACEHOLDERS[method]}
            autoComplete="off"
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
              {config.mode === "live" && method === "paypal"
                ? "Use the email, phone number, or PayPal ID that should receive the live payout."
                : METHOD_HELP[method]}
            </p>
          )}
        </div>

        {notificationsAvailable && (
          <label className="notification-choice">
            <input
              type="checkbox"
              checked={notifyBrowser}
              onChange={(event) => setNotifyBrowser(event.target.checked)}
            />
            <span>
              {config.mode === "live"
                ? "Notify me in this browser when the $5 arrives"
                : "Notify me in this browser when the demo finishes"}
              <small>
                {config.mode === "live"
                  ? "A transactional arrival email is sent automatically; browser alerts are optional."
                  : "You may be asked for notification permission."}
              </small>
            </span>
          </label>
        )}

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
                  : "Get me $5"}
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
        No password. No card. No upfront payment.
      </p>
    </section>
  );
}

export function FiveApp() {
  const [config, setConfig] = useState<AppConfig>({
    mode: "loading",
    liveReady: false,
    payoutMethods: [],
    availableFundedTasks: 0,
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
            payoutMethods: Array.isArray(payload.payoutMethods)
              ? payload.payoutMethods
              : ["paypal"],
            availableFundedTasks:
              typeof payload.availableFundedTasks === "number"
                ? payload.availableFundedTasks
                : 0,
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setConfig({
            mode: "sandbox",
            liveReady: false,
            payoutMethods: ["paypal", "zelle", "cashapp", "venmo", "other"],
            availableFundedTasks: 0,
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
            : "This demo simulates the workflow. No real money is earned or sent."}
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
              Your next $5,
              <span>handled.</span>
            </h1>
            <p className="hero-lede">
              Tell Five where to send it. The agent matches approved, funded work,
              completes the task, and tracks the reward from start to finish.
            </p>
            <div className="proof-row" aria-label="Product promises">
              <span><i aria-hidden="true" />No card needed</span>
              <span><i aria-hidden="true" />One fixed reward</span>
              <span><i aria-hidden="true" />Every step visible</span>
            </div>
            <p className="hero-qualifier">
              {live
                ? "Live rewards depend on funded task inventory and verified PayPal item status."
                : "Prototype experience. Live earning and payout providers are not connected yet."}
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
              <h3>Choose where</h3>
              <p>Pick a payout method and enter only the destination needed to route it.</p>
            </article>
            <article>
              <span className="step-number">02</span>
              <h3>Five gets to work</h3>
              <p>The agent matches an approved, funded opportunity and completes the work.</p>
            </article>
            <article>
              <span className="step-number">03</span>
              <h3>You get paid</h3>
              <p>Only after revenue settles, Five releases $5 and records the provider receipt.</p>
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
                <div><strong>A visible receipt</strong><p>Every job state and real provider update must be logged.</p></div>
              </li>
            </ul>
          </div>

          <aside
            className="receipt"
            aria-label={live ? "Live payout contract" : "Simulated agent receipt"}
          >
            <div className="receipt__top">
              <span>AGENT RECEIPT</span>
              <span className="receipt__stamp">{live ? "LIVE CONTRACT" : "SIMULATED"}</span>
            </div>
            <div className="receipt__amount"><span>$</span>5.00</div>
            <dl>
              <div><dt>Opportunity</dt><dd>Approved sponsor task</dd></div>
              <div><dt>Agent work</dt><dd>Completed + checked</dd></div>
              <div><dt>Revenue</dt><dd>Must be settled</dd></div>
              <div><dt>Payout</dt><dd>Provider receipt required</dd></div>
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
                  ? "Sponsors fund approved tasks through verified PayPal captures. The agent completes one and releases $5 only after its evidence contract accepts the work."
                  : "In a live version, sponsors pre-fund approved tasks. The agent completes one, quality-checks it, and shares $5 only after that revenue is accepted and settled."}
              </p>
            </details>
            <details>
              <summary>Is the $5 guaranteed?</summary>
              <p>
                Not unless a funded reward is already reserved. A real product must show inventory,
                eligibility, and timing before accepting a request.
              </p>
            </details>
            <details>
              <summary>What data does Five store?</summary>
              <p>
                {live
                  ? "Live requests store the authenticated owner email, an encrypted payout destination, a keyed fingerprint, a masked hint, workflow/provider receipts, and notification delivery state. The raw destination is never returned to the browser."
                  : "The demo saves a one-way hash and a masked hint—not the raw destination—plus the workflow status needed to keep the activity log consistent."}
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
