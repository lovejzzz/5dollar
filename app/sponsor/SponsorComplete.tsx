"use client";

import { useEffect, useRef, useState } from "react";

type SponsorDraft = {
  id: string;
  sponsorReference?: string;
  status: "draft" | "order_created" | "capture_pending" | "capture_retry" | "funded" | "canceled" | "needs_review" | "failed" | string;
  workStatus?: "waiting" | "working" | "result_ready" | "needs_review";
  result?: {
    answer?: string;
    evidence?: string[];
    qualityNotes?: string[];
  } | null;
  receipt?: {
    captureId?: string;
    grossCents?: number;
    netCents?: number;
    capturedAt?: string;
  } | null;
  title?: string;
  charge?: {
    currency?: string;
    grossCents?: number;
    minimumNetCents?: number;
    payoutCents?: number;
  };
  paypalOrderId?: string | null;
  fundedTaskId?: string | null;
  lastErrorCode?: string | null;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string | null;
};

type DraftResponse = {
  draft?: SponsorDraft;
  task?: SponsorDraft;
  error?: string;
  signInUrl?: string;
};

type Phase = "preview" | "capturing" | "polling" | "funded" | "needs_review" | "failed" | "canceled";

function safeSignInUrl(value: unknown) {
  return typeof value === "string" && /^\/signin-with-chatgpt(?:\?|$)/.test(value)
    ? value
    : "";
}

function isSafeIdentifier(value: string) {
  return /^[a-zA-Z0-9][a-zA-Z0-9._:-]{4,159}$/.test(value);
}

function money(cents?: number, currency = "USD") {
  if (!Number.isInteger(cents)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format((cents as number) / 100);
}

function statusCopy(draft?: SponsorDraft) {
  switch (draft?.status) {
    case "draft":
      return "Preparing the funding record…";
    case "order_created":
      return "Your PayPal order is recorded. Complete its approval to fund the task.";
    case "capture_pending":
      return "PayPal approved the order. FIVE is confirming the settled capture…";
    case "capture_retry":
      return "PayPal confirmation is taking longer than expected. FIVE is checking again safely…";
    case "funded":
      if (draft.workStatus === "result_ready") {
        return "The task passed its automatic evidence and length checks. Your accepted result is ready.";
      }
      if (draft.workStatus === "needs_review") {
        return "The task is funded, but its work result needs review before it can be accepted.";
      }
      if (draft.workStatus === "working") {
        return "Funding verified. FIVE is completing and checking the approved task now…";
      }
      return "Funding verified. Your task is waiting for FIVE to match and complete it…";
    case "canceled":
      return "PayPal confirmed no capture for this checkout. The draft is closed and will not count against active funding attempts.";
    case "needs_review":
      return "The PayPal capture needs review. The task has not been released to the agent.";
    case "failed":
      return "The task was not funded. No task was released to the agent.";
    default:
      return "Checking the latest funding status…";
  }
}

function formatDate(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function SponsorComplete({
  live,
  supportEmail,
  initialDraftId,
  paypalOrderId,
  canceled,
}: {
  live: boolean;
  supportEmail: string | null;
  initialDraftId: string;
  paypalOrderId: string;
  canceled: boolean;
}) {
  const [draft, setDraft] = useState<SponsorDraft | null>(null);
  const [phase, setPhase] = useState<Phase>(
    !live ? "preview" : canceled ? "canceled" : "capturing",
  );
  const [message, setMessage] = useState(
    !live
      ? "Sponsor checkout is not active in this sandbox preview."
      : canceled
        ? "PayPal checkout was closed. FIVE is checking the saved order before reporting its status."
        : "Confirming your PayPal approval…",
  );
  const [error, setError] = useState("");
  const [signInUrl, setSignInUrl] = useState("");
  const [attempt, setAttempt] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, [phase]);

  useEffect(() => {
    if (!live) return;

    const storedDraftId = sessionStorage.getItem("five:sponsor-draft-id") || "";
    const resolvedDraftId = initialDraftId || storedDraftId;
    if (!isSafeIdentifier(resolvedDraftId)) {
      const invalidLinkTimer = setTimeout(() => {
        setPhase("failed");
        setError("The sponsor return link is missing a valid task reference.");
        setMessage("We could not identify the task to fund.");
      }, 0);
      return () => clearTimeout(invalidLinkTimer);
    }
    const controller = new AbortController();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let transientFailures = 0;

    async function readPayload(response: Response) {
      return (await response.json().catch(() => ({}))) as DraftResponse;
    }

    async function poll() {
      if (stopped) return;
      try {
        const response = await fetch(
          `/api/sponsor/tasks/${encodeURIComponent(resolvedDraftId)}`,
          { cache: "no-store", signal: controller.signal },
        );
        const payload = await readPayload(response);
        if (!response.ok) {
          if (response.status === 401) {
            setSignInUrl(safeSignInUrl(payload.signInUrl));
            setPhase("failed");
            setMessage("Sign in again to continue viewing this sponsor task.");
            setError(payload.error || "Your sponsor session is no longer available.");
            return;
          }
          throw new Error(payload.error || "The latest task status is unavailable.");
        }
        const nextDraft = payload.draft || payload.task;
        if (!nextDraft) throw new Error("The status response was incomplete.");
        transientFailures = 0;
        setDraft(nextDraft);
        setMessage(statusCopy(nextDraft));
        setError("");
        if (nextDraft.status === "funded") {
          setPhase("funded");
          sessionStorage.removeItem("five:sponsor-draft-id");
          if (
            nextDraft.workStatus === "needs_review" ||
            (nextDraft.workStatus === "result_ready" && nextDraft.result)
          ) {
            return;
          }
          timer = setTimeout(poll, 8_000);
          return;
        }
        if (nextDraft.status === "canceled") {
          setPhase("canceled");
          setMessage(statusCopy(nextDraft));
          sessionStorage.removeItem("five:sponsor-draft-id");
          return;
        }
        if (nextDraft.status === "needs_review") {
          setPhase("needs_review");
          setError(
            "FIVE did not release the task because the capture could not be finalized unambiguously.",
          );
          return;
        }
        if (nextDraft.status === "failed") {
          setPhase("failed");
          setError("PayPal did not produce the verified settled funding required for this task.");
          return;
        }
        setPhase("polling");
        timer = setTimeout(poll, 2_500);
      } catch (pollError) {
        if (stopped || controller.signal.aborted) return;
        transientFailures += 1;
        setPhase("polling");
        setMessage("The status check was delayed. Retrying without creating another charge…");
        if (transientFailures >= 4) {
          setError(
            pollError instanceof Error
              ? pollError.message
              : "The latest task status is unavailable.",
          );
        }
        timer = setTimeout(poll, Math.min(3_000 + transientFailures * 1_000, 8_000));
      }
    }

    async function capture() {
      setPhase("capturing");
      setError("");
      setSignInUrl("");
      setMessage("Confirming your PayPal approval…");
      try {
        if (!paypalOrderId && !canceled) {
          setPhase("polling");
          setMessage("Checking the saved sponsor task and PayPal order…");
          await poll();
          return;
        }
        const action = canceled ? "cancel" : "capture";
        const response = await fetch(
          `/api/sponsor/orders/${encodeURIComponent(resolvedDraftId)}/${action}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(paypalOrderId ? { paypalOrderId } : {}),
            signal: controller.signal,
          },
        );
        const payload = await readPayload(response);
        if (!response.ok) {
          if (response.status === 401) setSignInUrl(safeSignInUrl(payload.signInUrl));
          const reviewDraft = payload.draft || payload.task;
          if (reviewDraft?.status === "needs_review") {
            setDraft(reviewDraft);
            setPhase("needs_review");
            setMessage(statusCopy(reviewDraft));
            setError(
              payload.error ||
                "FIVE did not release the task because the capture needs operator review.",
            );
            return;
          }
          throw new Error(payload.error || "The PayPal capture could not be confirmed.");
        }
        const capturedDraft = payload.draft || payload.task;
        if (capturedDraft) {
          setDraft(capturedDraft);
          setMessage(statusCopy(capturedDraft));
        }
        setPhase("polling");
        await poll();
      } catch (captureError) {
        if (stopped || controller.signal.aborted) return;
        setPhase("failed");
        setMessage("The funding confirmation needs your attention.");
        setError(
          captureError instanceof Error
            ? captureError.message
            : "The PayPal capture could not be confirmed.",
        );
      }
    }

    void capture();
    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [attempt, canceled, initialDraftId, live, paypalOrderId]);

  const status = draft?.status;
  const resultReady = status === "funded" && draft?.workStatus === "result_ready" && Boolean(draft.result);
  const workPending =
    status === "funded" &&
    (draft?.workStatus === undefined || draft.workStatus === "waiting" || draft.workStatus === "working");
  const reviewNeeded = phase === "needs_review" || draft?.workStatus === "needs_review";
  const authRequired = Boolean(signInUrl);
  const canRetry =
    phase === "failed" &&
    !authRequired &&
    !error.includes("missing a valid task reference");
  const supportHref =
    supportEmail && draft
      ? `mailto:${supportEmail}?subject=${encodeURIComponent(`FIVE sponsor review ${draft.sponsorReference ?? draft.id}`)}`
      : null;
  return (
    <div className="sponsor-shell sponsor-shell--complete">
      <header className="sponsor-header">
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- next/link currently breaks vinext client hydration. */}
        <a className="sponsor-brand" href="/" aria-label="FIVE home">
          <span aria-hidden="true">5</span>
          FIVE
        </a>
        <span className="sponsor-header__label">FUNDING STATUS</span>
      </header>

      <main className="sponsor-complete-main">
        <section className={`sponsor-result sponsor-result--${phase}`} aria-labelledby="sponsor-result-heading">
          <div className="sponsor-result__mark" aria-hidden="true">
            {phase === "preview" ? "5" : resultReady || phase === "funded" ? "✓" : phase === "failed" || phase === "canceled" || phase === "needs_review" ? "!" : "5"}
          </div>
          <p className="sponsor-kicker">
            {phase === "preview" ? "SPONSOR PREVIEW" : resultReady ? "RESULT ACCEPTED" : phase === "funded" ? "TASK FUNDED" : phase === "canceled" ? draft?.status === "canceled" ? "CANCEL CONFIRMED" : "CHECKOUT CLOSED" : authRequired ? "SIGN IN REQUIRED" : phase === "failed" || phase === "needs_review" ? "ACTION NEEDED" : "VERIFYING FUNDING"}
          </p>
          <h1 id="sponsor-result-heading" ref={headingRef} tabIndex={-1}>
            {phase === "preview"
              ? "Sponsor checkout is not live here."
              : resultReady
              ? "Your accepted result is ready."
              : reviewNeeded
                ? draft?.status === "funded"
                  ? "The work result needs review."
                  : "The capture needs review."
                : phase === "funded"
                  ? draft?.workStatus === "working"
                    ? "FIVE is working on your task."
                    : "Your task is funded and waiting."
              : phase === "canceled"
                ? draft?.status === "canceled"
                  ? "Checkout canceled."
                  : "Checking the saved order."
                : authRequired
                  ? "Sign in to continue."
                : phase === "failed"
                  ? "We could not finish funding."
                  : "PayPal approved. FIVE is checking the receipt."}
          </h1>

          <div className="sponsor-live-status" role="status" aria-live="polite" aria-atomic="true">
            <span className={phase === "capturing" || phase === "polling" || workPending ? "is-active" : phase === "failed" || phase === "canceled" || phase === "needs_review" ? "is-error" : phase === "preview" ? "is-neutral" : ""} aria-hidden="true" />
            <p>{message}</p>
          </div>

          {error && (
            <div className="sponsor-error-summary" role="alert">
              <strong>Funding status</strong>
              <p>{error}</p>
              {signInUrl && <a href={signInUrl}>Sign in with ChatGPT to continue →</a>}
            </div>
          )}

          {reviewNeeded && draft && (
            <div className="sponsor-support-path" role="note">
              <strong>Do not create or approve another payment.</strong>
              <p>
                Support must reconcile this exact sponsor reference before the
                task can continue. If the captured payment cannot activate the
                task, support can arrange the appropriate refund path.
              </p>
              <code>{draft.sponsorReference ?? draft.id}</code>
              {supportHref && <a href={supportHref}>Contact FIVE support →</a>}
            </div>
          )}

          {draft && (
            <div className="sponsor-result__details" aria-label="Sponsor task result">
              <h2>Funding receipt</h2>
              <dl>
                <div><dt>Task</dt><dd>{draft.title || "Dataset summary"}</dd></div>
                <div><dt>Funding status</dt><dd><span className={`sponsor-status sponsor-status--${status}`}>{status?.replaceAll("_", " ")}</span></dd></div>
                {draft.workStatus && <div><dt>Work status</dt><dd><span className={`sponsor-status sponsor-status--${draft.workStatus}`}>{draft.workStatus.replaceAll("_", " ")}</span></dd></div>}
                <div><dt>{draft.receipt ? "Captured amount" : "Order amount"}</dt><dd>{money(draft.receipt?.grossCents ?? draft.charge?.grossCents, draft.charge?.currency)}</dd></div>
                {draft.receipt && <div><dt>Settled net</dt><dd>{money(draft.receipt.netCents, draft.charge?.currency)}</dd></div>}
                <div><dt>Reserved reward</dt><dd>{money(draft.charge?.payoutCents, draft.charge?.currency)}</dd></div>
                {draft.receipt?.captureId && <div><dt>PayPal capture</dt><dd className="sponsor-mono">{draft.receipt.captureId}</dd></div>}
                {draft.receipt?.capturedAt && <div><dt>Captured</dt><dd>{formatDate(draft.receipt.capturedAt)}</dd></div>}
                {draft.sponsorReference && <div><dt>Sponsor reference</dt><dd className="sponsor-mono">{draft.sponsorReference}</dd></div>}
                {draft.fundedTaskId && <div><dt>Funded task</dt><dd className="sponsor-mono">{draft.fundedTaskId}</dd></div>}
              </dl>
            </div>
          )}

          {resultReady && draft?.result && (
            <section className="sponsor-work-result" aria-labelledby="accepted-result-heading">
              <div className="sponsor-work-result__heading">
                <div>
                  <p className="sponsor-kicker">AUTOMATIC CHECKS PASSED</p>
                  <h2 id="accepted-result-heading">Accepted result</h2>
                </div>
                <span>READY</span>
              </div>
              <div className="sponsor-work-result__answer">{draft.result.answer || "No answer text was returned."}</div>
              {Array.isArray(draft.result.evidence) && draft.result.evidence.length > 0 && (
                <div className="sponsor-work-result__list">
                  <h3>Evidence</h3>
                  <ul>{draft.result.evidence.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul>
                </div>
              )}
              {Array.isArray(draft.result.qualityNotes) && draft.result.qualityNotes.length > 0 && (
                <div className="sponsor-work-result__list">
                  <h3>Quality notes</h3>
                  <ul>{draft.result.qualityNotes.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul>
                </div>
              )}
            </section>
          )}

          <div className="sponsor-result__actions">
            {canRetry && (
              <button type="button" onClick={() => setAttempt((value) => value + 1)}>
                Check again
              </button>
            )}
            <a href={phase === "canceled" || phase === "preview" ? "/sponsor" : "/"}>
              {phase === "canceled" || phase === "preview" ? "Return to task form" : "Go to FIVE"}
            </a>
          </div>
          <p className="sponsor-result__note">
            {live
              ? "A PayPal approval alone never releases the task. FIVE requires a verified, completed USD capture with enough settled net funding."
              : "No PayPal order, charge, task inventory, or payout is created in sandbox sponsor preview mode."}
          </p>
        </section>
      </main>
    </div>
  );
}
