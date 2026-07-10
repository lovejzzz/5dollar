"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

type FieldErrors = Partial<
  Record<
    | "title"
    | "instructions"
    | "input"
    | "acceptance"
    | "minAnswerChars"
    | "automationAllowed"
    | "autoAccept"
    | "rightsAttested"
    | "noSensitiveData",
    string
  >
>;

type SponsorDraft = {
  id?: string;
};

type OrderResponse = {
  draft?: SponsorDraft;
  draftId?: string;
  approvalUrl?: string;
  error?: string;
  signInUrl?: string;
};

const SAMPLE_INPUT = JSON.stringify(
  {
    rows: [
      { id: "r1", feedback: "Setup was quick and the instructions were clear." },
      { id: "r2", feedback: "I wanted a more visible confirmation at the end." },
    ],
  },
  null,
  2,
);

const SAMPLE_ACCEPTANCE = JSON.stringify(
  {
    requiredEvidenceIds: ["r1", "r2"],
    minEvidenceCount: 2,
  },
  null,
  2,
);

function createUuid() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function safeSignInUrl(value: unknown) {
  return typeof value === "string" && /^\/signin-with-chatgpt(?:\?|$)/.test(value)
    ? value
    : "";
}

function safeApprovalUrl(value: unknown) {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value, window.location.origin);
    const paypalHost =
      url.hostname === "paypal.com" || url.hostname.endsWith(".paypal.com");
    const sameOrigin = url.origin === window.location.origin;
    if ((url.protocol === "https:" && (paypalHost || sameOrigin)) || (sameOrigin && url.protocol === "http:")) {
      return url.href;
    }
  } catch {
    // The server response is rendered as an actionable error below.
  }
  return "";
}

function collectEvidenceIds(value: unknown, ids: Set<string>, depth = 0) {
  if (depth > 20 || ids.size > 500 || !value) return;
  if (Array.isArray(value)) {
    value.forEach((entry) => collectEvidenceIds(entry, ids, depth + 1));
    return;
  }
  if (typeof value !== "object") return;
  Object.entries(value).forEach(([key, entry]) => {
    if (key === "id" && typeof entry === "string") ids.add(entry);
    collectEvidenceIds(entry, ids, depth + 1);
  });
}

function parseJsonField(value: string, label: string) {
  try {
    return { value: JSON.parse(value) as unknown, error: "" };
  } catch {
    return { value: undefined, error: `${label} must be valid JSON.` };
  }
}

const SAVED_FORM_KEY = "five:sponsor-form-draft";

export function SponsorForm({
  live,
  signedIn,
  sponsorAllowed,
  signInUrl: initialSignInUrl,
}: {
  live: boolean;
  signedIn: boolean;
  sponsorAllowed: boolean;
  signInUrl: string;
}) {
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [inputText, setInputText] = useState(SAMPLE_INPUT);
  const [acceptanceText, setAcceptanceText] = useState(SAMPLE_ACCEPTANCE);
  const [minAnswerChars, setMinAnswerChars] = useState("120");
  const [automationAllowed, setAutomationAllowed] = useState(false);
  const [autoAccept, setAutoAccept] = useState(false);
  const [rightsAttested, setRightsAttested] = useState(false);
  const [noSensitiveData, setNoSensitiveData] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState("");
  const [signInUrl, setSignInUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const requestId = useRef("");
  const errorSummary = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let canceled = false;
    try {
      const raw = sessionStorage.getItem(SAVED_FORM_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as Record<string, unknown>;
      if (typeof saved.clientRequestId === "string") {
        requestId.current = saved.clientRequestId;
      }
      queueMicrotask(() => {
        if (canceled) return;
        if (typeof saved.title === "string") setTitle(saved.title);
        if (typeof saved.instructions === "string") setInstructions(saved.instructions);
        if (typeof saved.inputText === "string") setInputText(saved.inputText);
        if (typeof saved.acceptanceText === "string") {
          setAcceptanceText(saved.acceptanceText);
        }
        if (typeof saved.minAnswerChars === "string") {
          setMinAnswerChars(saved.minAnswerChars);
        }
      });
    } catch {
      sessionStorage.removeItem(SAVED_FORM_KEY);
    }

    return () => {
      canceled = true;
    };
  }, []);

  function saveFormForSignIn() {
    if (!requestId.current) requestId.current = createUuid();
    sessionStorage.setItem(
      SAVED_FORM_KEY,
      JSON.stringify({
        clientRequestId: requestId.current,
        title,
        instructions,
        inputText,
        acceptanceText,
        minAnswerChars,
      }),
    );
  }

  function validate() {
    const nextErrors: FieldErrors = {};
    const cleanTitle = title.trim();
    const cleanInstructions = instructions.trim();
    const minimum = Number(minAnswerChars);
    const parsedInput = parseJsonField(inputText, "Task data");
    const parsedAcceptance = parseJsonField(acceptanceText, "Acceptance contract");

    if (cleanTitle.length < 5 || cleanTitle.length > 160) {
      nextErrors.title = "Use 5–160 characters for the task title.";
    }
    if (cleanInstructions.length < 30 || cleanInstructions.length > 6_000) {
      nextErrors.instructions = "Use 30–6,000 characters for the instructions.";
    }
    if (parsedInput.error) {
      nextErrors.input = parsedInput.error;
    } else if (
      new TextEncoder().encode(JSON.stringify(parsedInput.value)).byteLength > 20_000
    ) {
      nextErrors.input = "Task data must be no larger than 20 KB.";
    }
    if (parsedAcceptance.error) {
      nextErrors.acceptance = parsedAcceptance.error;
    } else if (
      !parsedAcceptance.value ||
      typeof parsedAcceptance.value !== "object" ||
      Array.isArray(parsedAcceptance.value)
    ) {
      nextErrors.acceptance = "Acceptance must be a JSON object.";
    } else {
      const contract = parsedAcceptance.value as Record<string, unknown>;
      const required = contract.requiredEvidenceIds;
      if (
        !Array.isArray(required) ||
        required.length < 1 ||
        required.length > 50 ||
        required.some((id) => typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(id)) ||
        new Set(required).size !== required.length
      ) {
        nextErrors.acceptance =
          "List 1–50 unique requiredEvidenceIds using source IDs from the task data.";
      } else if (!parsedInput.error) {
        const inputIds = new Set<string>();
        collectEvidenceIds(parsedInput.value, inputIds);
        const missing = required.filter((id) => !inputIds.has(id as string));
        if (missing.length > 0) {
          nextErrors.acceptance = `These evidence IDs are missing from the task data: ${missing.join(", ")}.`;
        }
      }
      if (
        contract.minEvidenceCount !== undefined &&
        (!Number.isInteger(contract.minEvidenceCount) ||
          Number(contract.minEvidenceCount) < 1 ||
          Number(contract.minEvidenceCount) > 50)
      ) {
        nextErrors.acceptance = "minEvidenceCount must be an integer from 1 to 50.";
      }
    }
    if (!Number.isInteger(minimum) || minimum < 40 || minimum > 4_000) {
      nextErrors.minAnswerChars = "Choose a minimum from 40 to 4,000 characters.";
    }
    if (!automationAllowed) {
      nextErrors.automationAllowed = "You must explicitly authorize automated completion.";
    }
    if (!autoAccept) {
      nextErrors.autoAccept = "You must accept the deterministic checks before funding.";
    }
    if (!rightsAttested) {
      nextErrors.rightsAttested = "Confirm that you have the right to use this task and data.";
    }
    if (!noSensitiveData) {
      nextErrors.noSensitiveData = "Confirm that the task contains no sensitive data.";
    }

    return {
      nextErrors,
      input: parsedInput.value,
      acceptance: parsedAcceptance.value,
      minimum,
      cleanTitle,
      cleanInstructions,
    };
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!live) {
      setFormError("Sponsor checkout is disabled in this sandbox preview.");
      return;
    }
    if (!signedIn) {
      saveFormForSignIn();
      window.location.assign(initialSignInUrl);
      return;
    }
    if (!sponsorAllowed) {
      setFormError(
        "Sponsor Checkout is currently limited to approved beta sponsors.",
      );
      requestAnimationFrame(() => errorSummary.current?.focus());
      return;
    }
    const validation = validate();
    if (Object.keys(validation.nextErrors).length > 0) {
      setErrors(validation.nextErrors);
      setFormError("Review the highlighted fields before continuing to PayPal.");
      requestAnimationFrame(() => errorSummary.current?.focus());
      return;
    }

    setSubmitting(true);
    setErrors({});
    setFormError("");
    setSignInUrl("");
    if (!requestId.current) requestId.current = createUuid();

    try {
      const response = await fetch("/api/sponsor/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientRequestId: requestId.current,
          title: validation.cleanTitle,
          instructions: validation.cleanInstructions,
          input: validation.input,
          acceptance: validation.acceptance,
          minAnswerChars: validation.minimum,
          automationAllowed,
          autoAccept,
          rightsAttested,
          noSensitiveData,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as OrderResponse;
      if (!response.ok) {
        const authUrl = response.status === 401 ? safeSignInUrl(payload.signInUrl) : "";
        setSignInUrl(authUrl);
        throw new Error(payload.error || "The PayPal approval could not be prepared.");
      }

      const approvalUrl = safeApprovalUrl(payload.approvalUrl);
      const draftId = payload.draft?.id || payload.draftId;
      if (!approvalUrl || !draftId) {
        throw new Error("The funding approval response was incomplete. Please try again.");
      }
      sessionStorage.setItem("five:sponsor-draft-id", draftId);
      sessionStorage.removeItem(SAVED_FORM_KEY);
      window.location.assign(approvalUrl);
    } catch (error) {
      setFormError(
        error instanceof Error ? error.message : "The PayPal approval could not be prepared.",
      );
      requestAnimationFrame(() => errorSummary.current?.focus());
      setSubmitting(false);
    }
  }

  function clearFieldError(field: keyof FieldErrors) {
    if (errors[field]) setErrors((current) => ({ ...current, [field]: undefined }));
    if (formError) setFormError("");
  }

  return (
    <div className="sponsor-shell">
      {!live && (
        <div className="sponsor-preview-strip" role="note">
          <strong>SPONSOR PREVIEW</strong>
          <span aria-hidden="true">·</span>
          No PayPal order or real charge can be created in this mode.
        </div>
      )}
      <a className="sponsor-skip" href="#sponsor-form">Skip to task form</a>
      <header className="sponsor-header">
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- next/link currently breaks vinext client hydration. */}
        <a className="sponsor-brand" href="/" aria-label="FIVE home">
          <span aria-hidden="true">5</span>
          FIVE
        </a>
        <span className="sponsor-header__label">
          {live ? "TASK FUNDING" : "SPONSOR PREVIEW"}
        </span>
      </header>

      <main className="sponsor-main">
        <section className="sponsor-intro" aria-labelledby="sponsor-heading">
          <p className="sponsor-kicker">SPONSOR AN APPROVED TASK</p>
          <h1 id="sponsor-heading">Fund useful work. Put $5 in someone’s hands.</h1>
          <p className="sponsor-intro__lede">
            Give FIVE a bounded dataset-summary task with objective evidence checks.
            {live
              ? " You approve the funding in PayPal; the agent can only use the data you supply."
              : " This page previews the contract and fields; checkout is not connected in sandbox mode."}
          </p>

          <aside className="sponsor-funding-card" aria-labelledby="funding-heading">
            <p className="sponsor-kicker">
              {live ? "FIXED FUNDING CONTRACT" : "PLANNED LIVE CONTRACT"}
            </p>
            <h2 id="funding-heading">$8.00 USD{live ? "" : " planned"}</h2>
            <dl>
              <div><dt>Recipient reward</dt><dd>$5.00</dd></div>
              <div><dt>Minimum settled net</dt><dd>$6.00</dd></div>
              <div><dt>Task type</dt><dd>Dataset summary</dd></div>
            </dl>
            <p>
              The task becomes available only after PayPal confirms the capture and
              the minimum net funding. One payment can fund one task. The settled
              amount above $5 covers AI execution and payout costs; an unresolved
              capture goes to support and must never be paid again.
            </p>
          </aside>
        </section>

        <section className="sponsor-form-card" aria-labelledby="task-details-heading">
          <div className="sponsor-card-heading">
            <span>01</span>
            <div>
              <p className="sponsor-kicker">TASK DETAILS</p>
              <h2 id="task-details-heading">Define the work and its proof</h2>
            </div>
          </div>

          {formError && (
            <div className="sponsor-error-summary" role="alert" tabIndex={-1} ref={errorSummary}>
              <strong>We could not continue</strong>
              <p>{formError}</p>
              {signInUrl && (
                <a href={signInUrl} onClick={saveFormForSignIn}>
                  Sign in with ChatGPT to continue →
                </a>
              )}
            </div>
          )}

          {live && !signedIn && !formError && (
            <div className="sponsor-signin-notice" role="status">
              <strong>Sign in before funding</strong>
              <p>
                Your ChatGPT identity owns the task and receipt. If you start
                drafting first, FIVE keeps these fields only in this browser tab
                while you sign in.
              </p>
              <a href={initialSignInUrl} onClick={saveFormForSignIn}>
                Sign in with ChatGPT →
              </a>
            </div>
          )}

          {live && signedIn && !sponsorAllowed && !formError && (
            <div className="sponsor-signin-notice" role="status">
              <strong>Private sponsor beta</strong>
              <p>
                New Checkout orders are limited to approved sponsors while FIVE
                validates privacy, payment, and support controls. Existing
                sponsor receipts remain available from their saved status links.
              </p>
            </div>
          )}

          <form id="sponsor-form" onSubmit={handleSubmit} noValidate>
            <div className="sponsor-field">
              <label htmlFor="task-title">Task title</label>
              <input
                id="task-title"
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value);
                  clearFieldError("title");
                }}
                placeholder="Summarize supplied product feedback"
                maxLength={160}
                aria-invalid={Boolean(errors.title)}
                aria-describedby={errors.title ? "task-title-error" : "task-title-help"}
              />
              <p className={errors.title ? "sponsor-field__error" : "sponsor-field__help"} id={errors.title ? "task-title-error" : "task-title-help"}>
                {errors.title || "A short, concrete name for the deliverable."}
              </p>
            </div>

            <div className="sponsor-field">
              <label htmlFor="task-instructions">Instructions</label>
              <textarea
                id="task-instructions"
                value={instructions}
                onChange={(event) => {
                  setInstructions(event.target.value);
                  clearFieldError("instructions");
                }}
                placeholder="Using only the supplied rows, produce a concise theme summary and cite the supporting row IDs."
                rows={5}
                maxLength={6_000}
                aria-invalid={Boolean(errors.instructions)}
                aria-describedby={errors.instructions ? "task-instructions-error" : "task-instructions-help"}
              />
              <p className={errors.instructions ? "sponsor-field__error" : "sponsor-field__help"} id={errors.instructions ? "task-instructions-error" : "task-instructions-help"}>
                {errors.instructions || `${instructions.length.toLocaleString()} / 6,000 characters. No outreach, purchases, account access, or external actions.`}
              </p>
            </div>

            <div className="sponsor-field">
              <label htmlFor="task-input">Task data (JSON)</label>
              <textarea
                id="task-input"
                className="sponsor-code-input"
                value={inputText}
                onChange={(event) => {
                  setInputText(event.target.value);
                  clearFieldError("input");
                }}
                rows={10}
                spellCheck={false}
                aria-invalid={Boolean(errors.input)}
                aria-describedby={errors.input ? "task-input-error" : "task-input-help"}
              />
              <p className={errors.input ? "sponsor-field__error" : "sponsor-field__help"} id={errors.input ? "task-input-error" : "task-input-help"}>
                {errors.input || "Every source item used for acceptance needs a unique id field. Maximum 20 KB."}
              </p>
            </div>

            <div className="sponsor-field sponsor-field--split">
              <div>
                <label htmlFor="task-acceptance">Acceptance contract (JSON)</label>
                <textarea
                  id="task-acceptance"
                  className="sponsor-code-input"
                  value={acceptanceText}
                  onChange={(event) => {
                    setAcceptanceText(event.target.value);
                    clearFieldError("acceptance");
                  }}
                  rows={7}
                  spellCheck={false}
                  aria-invalid={Boolean(errors.acceptance)}
                  aria-describedby={errors.acceptance ? "task-acceptance-error" : "task-acceptance-help"}
                />
                <p className={errors.acceptance ? "sponsor-field__error" : "sponsor-field__help"} id={errors.acceptance ? "task-acceptance-error" : "task-acceptance-help"}>
                  {errors.acceptance || "Required IDs must exist in the task data above."}
                </p>
              </div>
              <div>
                <label htmlFor="min-answer-chars">Minimum answer length</label>
                <input
                  id="min-answer-chars"
                  type="number"
                  min={40}
                  max={4_000}
                  step={1}
                  inputMode="numeric"
                  value={minAnswerChars}
                  onChange={(event) => {
                    setMinAnswerChars(event.target.value);
                    clearFieldError("minAnswerChars");
                  }}
                  aria-invalid={Boolean(errors.minAnswerChars)}
                  aria-describedby={errors.minAnswerChars ? "min-answer-error" : "min-answer-help"}
                />
                <p className={errors.minAnswerChars ? "sponsor-field__error" : "sponsor-field__help"} id={errors.minAnswerChars ? "min-answer-error" : "min-answer-help"}>
                  {errors.minAnswerChars || "The accepted answer must meet this character count."}
                </p>
              </div>
            </div>

            <fieldset className="sponsor-attestations">
              <legend>Required confirmations</legend>
              <SponsorCheck
                id="automation-allowed"
                checked={automationAllowed}
                onChange={(checked) => {
                  setAutomationAllowed(checked);
                  clearFieldError("automationAllowed");
                }}
                error={errors.automationAllowed}
                label="I authorize an AI agent to complete this task automatically."
              />
              <SponsorCheck
                id="auto-accept"
                checked={autoAccept}
                onChange={(checked) => {
                  setAutoAccept(checked);
                  clearFieldError("autoAccept");
                }}
                error={errors.autoAccept}
                label="I accept the result automatically if it passes the evidence and length checks above."
              />
              <SponsorCheck
                id="rights-attested"
                checked={rightsAttested}
                onChange={(checked) => {
                  setRightsAttested(checked);
                  clearFieldError("rightsAttested");
                }}
                error={errors.rightsAttested}
                label="I own this task and data, or I have the right to submit and process them."
              />
              <SponsorCheck
                id="no-sensitive-data"
                checked={noSensitiveData}
                onChange={(checked) => {
                  setNoSensitiveData(checked);
                  clearFieldError("noSensitiveData");
                }}
                error={errors.noSensitiveData}
                label="This task contains no passwords, payment credentials, private records, or sensitive personal data."
              />
            </fieldset>

            <div className="sponsor-submit-row">
              <div>
                <strong>$8.00 USD</strong>
                <span>You review and approve the payment on PayPal.</span>
              </div>
              {!live ? (
                <button type="button" disabled>
                  Live checkout unavailable
                </button>
              ) : !signedIn ? (
                <a
                  className="sponsor-login-cta"
                  href={initialSignInUrl}
                  onClick={saveFormForSignIn}
                >
                  Sign in to fund <span aria-hidden="true">→</span>
                </a>
              ) : !sponsorAllowed ? (
                <button type="button" disabled>
                  Sponsor beta access required
                </button>
              ) : (
                <button type="submit" disabled={submitting}>
                  {submitting ? "Preparing PayPal…" : "Continue to PayPal"}
                  <span aria-hidden="true">→</span>
                </button>
              )}
            </div>
          </form>
        </section>
      </main>
    </div>
  );
}

function SponsorCheck({
  id,
  checked,
  onChange,
  error,
  label,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  error?: string;
  label: string;
}) {
  return (
    <div className="sponsor-check-wrap">
      <label className="sponsor-check" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${id}-error` : undefined}
        />
        <span aria-hidden="true">✓</span>
        <span>{label}</span>
      </label>
      {error && <p className="sponsor-field__error" id={`${id}-error`}>{error}</p>}
    </div>
  );
}
