"use client";

import {
  AlertCircle,
  AlertTriangle,
  Check,
  Copy,
  FileText,
  FileUp,
  Link2,
  Loader2,
  Lock,
  RefreshCw,
  ShieldCheck,
  Unlink,
} from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import {
  completeUploadAction,
  generateLinkAction,
  loadProposalSetupAction,
  prepareUploadAction,
  revokeLinkAction,
  saveOfferAction,
} from "@/app/(dashboard)/dashboard/proposal-setup-actions";
import { Dialog } from "@/components/ui/dialog";
import { describedBy, FieldLabel, FieldMessages, SelectChevron } from "@/components/ui/fields";
import {
  badgeStyles,
  buttonStyles,
  calloutStyles,
  controlStyles,
  inputStyles,
  selectStyles,
  skeletonStyles,
} from "@/components/ui/styles";
import { useHydrated } from "@/components/ui/use-hydrated";
import {
  formatFromFileName,
  formatInfo,
  formatLabel,
  type DocumentFormat,
} from "@/lib/documents/formats";
import { formatBytes, formatDateTime } from "@/lib/format";
import {
  CURRENCIES,
  CURRENCY_CODES,
  formatPrice,
  isCurrencyCode,
  minorToInput,
  parsePrice,
} from "@/lib/proposals/currencies";
import { PROPOSALS_BUCKET } from "@/lib/proposals/paths";
import type { ProposalSetup, SetupResult } from "@/lib/proposals/setup-types";
import { createClient } from "@/lib/supabase/client";

export type PdfLimitsProps = { maxBytes: number; maxPages: number };

type Busy = "upload" | "offer" | "link" | "revoke" | "load" | null;
type Banner = { tone: "error" | "success"; text: string; stale?: boolean } | null;
type UploadPhase = "uploading" | "verifying";

export function ProposalSetupDialog({
  proposal,
  limits,
}: {
  proposal: { id: string; title: string };
  limits: PdfLimitsProps;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // A new key per opening loads fresh data. The panel stays mounted while the
  // dialog fades out and is then removed, so a shown link doesn't linger.
  const [openCount, setOpenCount] = useState(0);
  const [panelMounted, setPanelMounted] = useState(false);
  const hydrated = useHydrated();

  return (
    <>
      <button
        type="button"
        className={buttonStyles.rowAction}
        aria-haspopup="dialog"
        aria-label={`Manage Document and link for ${proposal.title}`}
        disabled={!hydrated}
        onClick={() => {
          setOpenCount((count) => count + 1);
          setPanelMounted(true);
          setOpen(true);
        }}
      >
        <FileUp aria-hidden="true" />
        <span className="md:max-lg:sr-only">Manage Document</span>
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        onExited={() => setPanelMounted(false)}
        title="Manage document and link"
        description={proposal.title}
        size="wide"
        busy={busy}
      >
        {panelMounted ? (
          <SetupPanel key={openCount} proposalId={proposal.id} limits={limits} onBusyChange={setBusy} />
        ) : null}
      </Dialog>
    </>
  );
}

function SetupPanel({
  proposalId,
  limits,
  onBusyChange,
}: {
  proposalId: string;
  limits: PdfLimitsProps;
  onBusyChange: (busy: boolean) => void;
}) {
  const [setup, setSetup] = useState<ProposalSetup | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>("load");
  const [banner, setBanner] = useState<Banner>(null);
  const [issuedLink, setIssuedLink] = useState<{ url: string; localOnly: boolean } | null>(null);
  const [uploadPhase, setUploadPhase] = useState<UploadPhase>("uploading");
  const [uploadFormat, setUploadFormat] = useState<DocumentFormat>("pdf");

  // Escape/close are blocked while a change is being saved (not while loading).
  // A layout effect, so the dialog is marked busy in the same paint as the
  // pending controls and there is no moment where Escape could still close it.
  useLayoutEffect(() => {
    onBusyChange(busy !== null && busy !== "load");
  }, [busy, onBusyChange]);

  useEffect(() => {
    let cancelled = false;
    loadProposalSetupAction(proposalId).then((result) => {
      if (cancelled) return;
      if (result.ok) setSetup(result.data);
      else setLoadError(result.message);
      setBusy(null);
    });
    return () => {
      cancelled = true;
    };
  }, [proposalId]);

  async function reload() {
    setBusy("load");
    setBanner(null);
    const result = await loadProposalSetupAction(proposalId);
    if (result.ok) {
      setSetup(result.data);
      setLoadError(null);
    } else {
      setLoadError(result.message);
    }
    setBusy(null);
  }

  // Runs one server step at a time; all controls are disabled meanwhile, so
  // double submits from this dialog are impossible.
  async function run<T>(
    kind: Exclude<Busy, null>,
    step: () => Promise<SetupResult<T>>,
    applySetup: (data: T) => ProposalSetup,
  ): Promise<SetupResult<T>> {
    setBusy(kind);
    setBanner(null);
    try {
      const result = await step();
      if (result.ok) {
        setSetup(applySetup(result.data));
        setBanner({ tone: "success", text: result.message });
      } else {
        setBanner({ tone: "error", text: result.message, stale: result.stale });
      }
      return result;
    } catch {
      const failure = { ok: false as const, message: "The request failed. Check your connection and try again." };
      setBanner({ tone: "error", text: failure.message });
      return failure;
    } finally {
      setBusy(null);
    }
  }

  if (!setup) {
    return loadError ? (
      <div className="space-y-4">
        <p role="alert" className={`${calloutStyles.error} flex items-start gap-2`}>
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{loadError}</span>
        </p>
        <button type="button" className={buttonStyles.secondary} onClick={reload} disabled={busy !== null}>
          {busy === "load" ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
          Try again
        </button>
      </div>
    ) : (
      <SetupSkeleton />
    );
  }

  const locked = setup.status !== "draft";
  const steps = stepStates(setup);

  return (
    <div className="space-y-6">
      <p className="text-[15px] text-muted">
        Client: <span className="font-medium text-foreground">{setup.clientName}</span>
        {setup.ownerName ? (
          <>
            {" · "}Owner: <span className="font-medium text-foreground">{setup.ownerName}</span>
          </>
        ) : null}
      </p>

      <Stepper steps={steps} />

      {banner ? (
        <div
          role={banner.tone === "error" ? "alert" : "status"}
          className={`animate-fade-in flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between ${
            banner.tone === "error" ? calloutStyles.error : calloutStyles.success
          }`}
        >
          <span className="flex items-start gap-2">
            {banner.tone === "error" ? (
              <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            ) : (
              <Check className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            )}
            <span>{banner.text}</span>
          </span>
          {banner.stale ? (
            <button type="button" className={buttonStyles.secondaryCompact} onClick={reload} disabled={busy !== null}>
              <RefreshCw aria-hidden="true" />
              Reload
            </button>
          ) : null}
        </div>
      ) : null}

      {locked ? (
        <p className={`${calloutStyles.warning} flex items-start gap-2`} data-locked-notice>
          <Lock className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>
            {setup.status === "active"
              ? "This proposal has an active link, so its document and offer can't be changed. To make changes, revoke the link: the proposal returns to draft and the old link stops working."
              : "Archived proposals can't be changed."}
          </span>
        </p>
      ) : null}

      <DocumentSection
        setup={setup}
        limits={limits}
        disabled={locked || busy !== null}
        busy={busy}
        uploadPhase={uploadPhase}
        uploadFormat={uploadFormat}
        onFormatChosen={setUploadFormat}
        state={steps[0]}
        onUpload={(file, format) =>
          run(
            "upload",
            async () => {
              setUploadPhase("uploading");
              const ticket = await prepareUploadAction({ proposalId, sizeBytes: file.size, format });
              if (!ticket.ok) return ticket;
              const { contentType } = ticket.data;
              const { error } = await createClient()
                .storage.from(PROPOSALS_BUCKET)
                // Re-typed: some systems report an empty or odd MIME type, which
                // the bucket would refuse. The server still identifies the file
                // from its bytes, whatever it was declared as.
                .uploadToSignedUrl(ticket.data.path, ticket.data.token, file.slice(0, file.size, contentType), {
                  contentType,
                  upsert: false,
                });
              if (error) {
                return {
                  ok: false,
                  message: "The upload failed. Check your connection and try again.",
                  fieldErrors: { file: "The upload failed. Try again." },
                };
              }
              setUploadPhase("verifying");
              return completeUploadAction({
                proposalId,
                revision: ticket.data.revision,
                expectedRevision: setup.document?.revision ?? null,
                fileName: file.name,
                format,
              });
            },
            (data) => data,
          )
        }
      />

      <OfferSection
        key={`${setup.document?.revision ?? "none"}:${setup.preview?.revision ?? "none"}`}
        setup={setup}
        disabled={locked || busy !== null || !setup.document}
        busy={busy}
        state={steps[1]}

        onSave={(values) =>
          run(
            "offer",
            () =>
              saveOfferAction({
                proposalId,
                expectedRevision: setup.document!.revision,
                ...values,
              }),
            (data) => data,
          )
        }
      />

      <LinkSection
        setup={setup}
        busy={busy}
        state={steps[2]}
        issuedLink={issuedLink}
        onGenerate={async () => {
          const result = await run(
            "link",
            () =>
              generateLinkAction({
                proposalId,
                expectedPreviewRevision: setup.preview!.revision,
              }),
            (data) => data.setup,
          );
          if (result.ok) setIssuedLink({ url: result.data.url, localOnly: result.data.localOnly });
        }}
        onRevoke={async () => {
          const result = await run("revoke", () => revokeLinkAction({ proposalId }), (data) => data);
          if (result.ok) setIssuedLink(null);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

type StepState = "done" | "current" | "upcoming";

const STEP_TITLES = ["Upload document", "Preview & price", "Private link"] as const;

// Derived only from saved server state: done steps, then the first open step.
function stepStates(setup: ProposalSetup): [StepState, StepState, StepState] {
  const done = [
    Boolean(setup.document),
    offerReady(setup),
    setup.status === "active" && Boolean(setup.link),
  ];
  const current = done.indexOf(false);
  return done.map((isDone, index) => (isDone ? "done" : index === current ? "current" : "upcoming")) as [
    StepState,
    StepState,
    StepState,
  ];
}

function offerReady(setup: ProposalSetup) {
  return Boolean(setup.preview && setup.offer.priceMinor && setup.offer.currency);
}

function Stepper({ steps }: { steps: StepState[] }) {
  return (
    <ol className="grid grid-cols-3 gap-2 sm:gap-3" aria-label="Setup progress">
      {steps.map((state, index) => (
        <li key={STEP_TITLES[index]} className="min-w-0" aria-current={state === "current" ? "step" : undefined}>
          <div
            className={`h-1.5 rounded-full transition-colors duration-200 ${
              state === "done" ? "bg-accent" : state === "current" ? "bg-accent-border" : "bg-surface-sunken"
            }`}
            aria-hidden="true"
          />
          <p className="mt-3 flex flex-col items-start gap-1.5 text-sm font-medium leading-5 sm:flex-row sm:items-center sm:gap-2 sm:text-[15px]">
            <StepIcon state={state} number={index + 1} />
            <span className={`min-w-0 break-words ${state === "upcoming" ? "text-subtle" : "text-navy"}`}>
              {STEP_TITLES[index]}
            </span>
            <span className="sr-only">{state === "done" ? "(done)" : state === "current" ? "(next)" : "(to do)"}</span>
          </p>
        </li>
      ))}
    </ol>
  );
}

function StepIcon({ state, number }: { state: StepState; number: number }) {
  if (state === "done") {
    return (
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground" aria-hidden="true">
        <Check className="size-4" strokeWidth={3} />
      </span>
    );
  }
  return (
    <span
      className={`flex size-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold tabular-nums ${
        state === "current" ? "bg-accent-soft text-accent-strong ring-1 ring-accent-border" : "bg-surface-sunken text-subtle"
      }`}
      aria-hidden="true"
    >
      {number}
    </span>
  );
}

function Section({
  title,
  step,
  state,
  children,
}: {
  title: string;
  step: number;
  state: StepState;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className={`space-y-5 rounded-xl border p-4 transition-[border-color,box-shadow] duration-200 sm:p-6 ${
        state === "current" ? "border-accent-border shadow-[0_0_0_4px_var(--accent-soft)]" : "border-border"
      }`}
    >
      <h3 id={headingId} className="flex items-center gap-3 text-lg font-semibold tracking-tight text-navy">
        <span
          className={`flex size-8 shrink-0 items-center justify-center rounded-full text-sm tabular-nums ${
            state === "done"
              ? "bg-accent text-accent-foreground"
              : state === "current"
                ? "bg-accent-soft text-accent-strong"
                : "bg-surface-sunken text-subtle"
          }`}
          aria-hidden="true"
        >
          {state === "done" ? <Check className="size-4" strokeWidth={3} /> : step}
        </span>
        <span>
          <span className="sr-only">Step {step}: </span>
          {title}
        </span>
        <span className="sr-only">{state === "done" ? "(done)" : "(to do)"}</span>
      </h3>
      {children}
    </section>
  );
}

function SetupSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true">
      <p className="sr-only" role="status">
        Loading proposal…
      </p>
      <div className={`${skeletonStyles} h-6 w-64 max-w-full`} aria-hidden="true" />
      <div className="grid grid-cols-3 gap-2 sm:gap-3" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-3">
            <div className={`${skeletonStyles} h-1.5`} />
            <div className={`${skeletonStyles} h-7 w-24 max-w-full`} />
          </div>
        ))}
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="space-y-5 rounded-xl border border-border p-4 sm:p-6" aria-hidden="true">
          <div className={`${skeletonStyles} h-8 w-44`} />
          <div className={`${skeletonStyles} h-12`} />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1. Upload document
// ---------------------------------------------------------------------------

function DocumentSection({
  setup,
  limits,
  disabled,
  busy,
  uploadPhase,
  uploadFormat,
  onFormatChosen,
  state,
  onUpload,
}: {
  setup: ProposalSetup;
  limits: PdfLimitsProps;
  disabled: boolean;
  busy: Busy;
  uploadPhase: UploadPhase;
  uploadFormat: DocumentFormat;
  onFormatChosen: (format: DocumentFormat) => void;
  state: StepState;
  onUpload: (file: File, format: DocumentFormat) => Promise<SetupResult<ProposalSetup>>;
}) {
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | undefined>();
  const doc = setup.document;
  const { enabled, unavailable, unavailableReason } = setup.upload;
  const enabledList = enabled.map((id) => formatInfo(id).extension.toUpperCase());
  // The file picker's filter is a convenience only: the server accepts a
  // format only if it is enabled there, and identifies files from their bytes.
  const accept = enabled.flatMap((id) => [`.${formatInfo(id).extension}`, formatInfo(id).mime]).join(",");

  async function submit() {
    if (!file) return setFileError("Choose a document.");
    // Quick checks for fast feedback only; the server verifies the stored bytes.
    const format = formatFromFileName(file.name) ?? (file.type === "application/pdf" ? "pdf" : null);
    if (!format) return setFileError(`Choose a ${joinFormats(enabledList)} file.`);
    if (!enabled.includes(format)) {
      return setFileError(
        `${formatInfo(format).extension.toUpperCase()} files can't be uploaded here right now.${unavailableReason ? ` ${unavailableReason}` : ""}`,
      );
    }
    if (file.size === 0) return setFileError("This file is empty. Choose another file.");
    if (file.size > limits.maxBytes) {
      return setFileError(`This file is ${formatBytes(file.size)}. The limit is ${formatBytes(limits.maxBytes)}.`);
    }
    setFileError(undefined);
    onFormatChosen(format);
    const result = await onUpload(file, format);
    if (result.ok) {
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
    } else {
      setFileError(result.fieldErrors?.file);
    }
  }

  return (
    <Section title="Upload document" step={1} state={state}>
      {doc ? (
        <div className="flex items-start gap-4 rounded-lg border border-border bg-surface-muted p-4" data-document-summary>
          <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
            <FileText className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="break-all text-[15px] font-medium text-foreground">{doc.fileName ?? "Document"}</p>
            <p className="text-sm text-muted">
              {doc.sizeBytes ? `${formatBytes(doc.sizeBytes)} · ` : ""}
              {doc.totalPages} {doc.totalPages === 1 ? "page" : "pages"}
              {doc.sourceFormat ? ` · ${formatLabel(doc.sourceFormat)}, converted to PDF on the server` : " · PDF"}
            </p>
          </div>
          <span className={badgeStyles.success}>
            <ShieldCheck className="size-3.5" aria-hidden="true" />
            Verified
          </span>
        </div>
      ) : (
        <p className="text-sm text-muted">No document uploaded yet.</p>
      )}

      <div className="space-y-1.5">
        <FieldLabel htmlFor={inputId}>{doc ? "Replace document" : "Choose a document"}</FieldLabel>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            ref={inputRef}
            id={inputId}
            type="file"
            accept={accept}
            disabled={disabled}
            aria-invalid={fileError ? true : undefined}
            aria-describedby={describedBy([hintId, fileError && errorId])}
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setFileError(undefined);
            }}
            className={`${controlStyles} min-h-12 px-2 py-2 text-sm file:mr-3 file:h-8 file:cursor-pointer file:rounded-md file:border-0 file:bg-accent-soft file:px-3 file:text-sm file:font-medium file:text-accent-strong hover:file:bg-blue-100`}
          />
          <button
            type="button"
            className={doc ? buttonStyles.secondary : buttonStyles.primary}
            disabled={disabled || !file}
            onClick={submit}
          >
            {busy === "upload" ? <Loader2 className="animate-spin" aria-hidden="true" /> : <FileUp aria-hidden="true" />}
            {doc ? "Upload replacement" : "Upload document"}
          </button>
        </div>
        <FieldMessages
          hintId={hintId}
          errorId={errorId}
          error={fileError}
          hint={
            <>
              {joinFormats(enabledList)}: up to {limits.maxPages} pages and {formatBytes(limits.maxBytes)}. Other
              formats are converted to PDF on the server. Password-protected files and files with macros can&apos;t
              be used. A preview link needs at least 2 pages.
              {doc ? " Replacing the document removes the current preview, so save the price again afterwards." : ""}
            </>
          }
        />
      </div>

      {unavailable.length > 0 ? (
        <p className="text-sm leading-6 text-subtle" data-unavailable-formats>
          Not available on this server: {joinFormats(unavailable.map((id) => formatInfo(id).extension.toUpperCase()))}.{" "}
          {unavailableReason}
        </p>
      ) : null}

      {busy === "upload" ? <UploadProgress phase={uploadPhase} converting={uploadFormat !== "pdf"} /> : null}
    </Section>
  );
}

// Real phases only (no percentage): the upload, then the server's checks.
function UploadProgress({ phase, converting }: { phase: UploadPhase; converting: boolean }) {
  const items: { id: UploadPhase; label: string }[] = [
    { id: "uploading", label: "Uploading to private storage" },
    {
      id: "verifying",
      label: converting ? "Checking the file, converting it to PDF and counting pages" : "Checking the file and counting pages",
    },
  ];
  const currentIndex = items.findIndex((item) => item.id === phase);
  return (
    <ol className="space-y-2 rounded-lg border border-accent-border bg-accent-soft px-4 py-3 text-[15px]" role="status">
      {items.map((item, index) => (
        <li key={item.id} className="flex items-center gap-2">
          {index < currentIndex ? (
            <Check className="size-4 text-accent" aria-hidden="true" />
          ) : index === currentIndex ? (
            <Loader2 className="size-4 animate-spin text-accent" aria-hidden="true" />
          ) : (
            <span className="flex size-4 items-center justify-center" aria-hidden="true">
              <span className="size-1.5 rounded-full bg-accent-border" />
            </span>
          )}
          <span className={index <= currentIndex ? "text-accent-strong" : "text-subtle"}>
            {item.label}
            {index < currentIndex ? <span className="sr-only"> (done)</span> : null}
            {index === currentIndex ? "…" : ""}
          </span>
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// 2. Preview pages and price
// ---------------------------------------------------------------------------

type OfferValues = { freePages: string; price: string; currency: string };

function OfferSection({
  setup,
  disabled,
  busy,
  state,
  onSave,
}: {
  setup: ProposalSetup;
  disabled: boolean;
  busy: Busy;
  state: StepState;
  onSave: (values: OfferValues) => Promise<SetupResult<ProposalSetup>>;
}) {
  const ids = { pages: useId(), price: useId(), currency: useId() };
  const total = setup.document?.totalPages ?? null;
  const { freePages, priceMinor, currency } = setup.offer;
  const saved = Boolean(setup.preview && priceMinor && currency);

  // Values stay as typed after a validation error.
  const [values, setValues] = useState<OfferValues>({
    freePages: freePages ? String(freePages) : "",
    price: priceMinor && currency ? minorToInput(priceMinor, currency) : "",
    currency: currency ?? "",
  });
  const [errors, setErrors] = useState<Partial<Record<keyof OfferValues, string>>>({});

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setErrors({});
    const result = await onSave(values);
    if (!result.ok && result.fieldErrors) setErrors(result.fieldErrors);
  }

  const update = (field: keyof OfferValues) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setValues((current) => ({ ...current, [field]: event.target.value }));

  const idOf = (field: keyof OfferValues) => ids[field === "freePages" ? "pages" : field];
  const describe = (field: keyof OfferValues, hintId?: string) =>
    describedBy([hintId, errors[field] && `${idOf(field)}-error`]);

  // Live summary of what the client will see, from the values being edited.
  const free = /^\d+$/.test(values.freePages) ? Number(values.freePages) : null;
  const validFree = total !== null && free !== null && free >= 1 && free < total ? free : null;
  const livePrice =
    isCurrencyCode(values.currency) && values.price ? parsePrice(values.price, values.currency) : null;
  const minorDigits = isCurrencyCode(values.currency) ? CURRENCIES[values.currency].minorDigits : null;

  return (
    <Section title="Preview & price" step={2} state={state}>
      <>
          {!setup.document ? (
            <p className="text-sm text-muted">Upload a document first. Then choose how many pages are free and set the price.</p>
          ) : null}

          {setup.document && total === 1 ? (
            <p className={`${calloutStyles.warning} flex items-start gap-2`} data-one-page-notice>
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>
                This document needs at least two pages: one free preview page and one locked page.
                Upload a longer document.
              </span>
            </p>
          ) : null}

          {setup.document && total ? (
            <PageSplit total={total} free={validFree} />
          ) : null}

          <form onSubmit={submit} noValidate className="space-y-4">
            <fieldset disabled={disabled} className="grid gap-4 sm:grid-cols-3">
              <legend className="sr-only">Preview and price (all fields required)</legend>
              <div className="space-y-1.5">
                <FieldLabel htmlFor={ids.pages}>
                  Free preview pages
                </FieldLabel>
                <input
                  id={ids.pages}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={total ? total - 1 : undefined}
                  step={1}
                  aria-required="true"
                  value={values.freePages}
                  onChange={update("freePages")}
                  aria-invalid={errors.freePages ? true : undefined}
                  aria-describedby={describe("freePages", `${ids.pages}-hint`)}
                  className={inputStyles}
                />
                <FieldMessages
                  hintId={`${ids.pages}-hint`}
                  errorId={`${ids.pages}-error`}
                  error={errors.freePages}
                  hint={total ? `1 to ${total - 1}. At least one page stays locked.` : "At least one page stays locked."}
                />
              </div>

              <div className="space-y-1.5">
                <FieldLabel htmlFor={ids.currency}>
                  Currency
                </FieldLabel>
                <SelectChevron>
                  <select
                    id={ids.currency}
                    aria-required="true"
                    value={values.currency}
                    onChange={update("currency")}
                    aria-invalid={errors.currency ? true : undefined}
                    aria-describedby={describe("currency")}
                    className={selectStyles}
                  >
                    <option value="">Select…</option>
                    {CURRENCY_CODES.map((code) => (
                      <option key={code} value={code}>
                        {code} — {CURRENCIES[code].name}
                      </option>
                    ))}
                  </select>
                </SelectChevron>
                <FieldMessages hintId={`${ids.currency}-hint`} errorId={`${ids.currency}-error`} error={errors.currency} />
              </div>

              <div className="space-y-1.5">
                <FieldLabel htmlFor={ids.price}>
                  Unlock price
                </FieldLabel>
                <div className="relative">
                  <input
                    id={ids.price}
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder={values.currency === "JPY" ? "1500" : "49.99"}
                    aria-required="true"
                    value={values.price}
                    onChange={update("price")}
                    aria-invalid={errors.price ? true : undefined}
                    aria-describedby={describe("price", `${ids.price}-hint`)}
                    className={`${inputStyles} ${isCurrencyCode(values.currency) ? "pr-14" : ""}`}
                  />
                  {isCurrencyCode(values.currency) ? (
                    <span
                      className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-sm font-medium text-subtle"
                      aria-hidden="true"
                    >
                      {values.currency}
                    </span>
                  ) : null}
                </div>
                <FieldMessages
                  hintId={`${ids.price}-hint`}
                  errorId={`${ids.price}-error`}
                  error={errors.price}
                  hint={
                    minorDigits === null
                      ? "Select the currency first."
                      : minorDigits === 0
                        ? "Whole amounts only."
                        : `Up to ${minorDigits} decimal places.`
                  }
                />
              </div>
            </fieldset>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-[15px] text-muted" aria-live="polite">
                {livePrice?.ok && isCurrencyCode(values.currency) ? (
                  <>
                    Clients will see{" "}
                    <span className="font-semibold text-foreground" data-price-preview>
                      {formatPrice(livePrice.minor, values.currency)}
                    </span>
                    {saved && livePrice.minor === priceMinor && values.currency === currency ? " (saved)" : ""}
                  </>
                ) : saved ? null : setup.document ? (
                  "Not saved yet. Saving creates the preview PDF."
                ) : null}
              </p>
              <button type="submit" className={buttonStyles.primary} disabled={disabled || total === 1}>
                {busy === "offer" ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
                {busy === "offer" ? "Generating preview…" : "Save offer and generate preview"}
              </button>
            </div>
          </form>
      </>
    </Section>
  );
}

// Proportional bar: free pages in blue, locked pages in grey.
function PageSplit({ total, free }: { total: number; free: number | null }) {
  const locked = free === null ? null : total - free;
  const freeShare = free === null ? 0 : Math.max((free / total) * 100, 4);
  return (
    <div className="space-y-2" data-page-split>
      <div className="flex h-2.5 overflow-hidden rounded-full bg-surface-sunken" aria-hidden="true">
        <div className="h-full bg-accent transition-[width] duration-200 ease-out" style={{ width: `${freeShare}%` }} />
      </div>
      {free !== null && locked !== null ? (
        <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-sm">
          <span className="flex items-center gap-1.5 text-accent-strong">
            <span className="size-2 rounded-full bg-accent" aria-hidden="true" />
            Free: {free === 1 ? "page 1" : `pages 1–${free}`}
          </span>
          <span className="flex items-center gap-1.5 text-muted">
            <Lock className="size-3" aria-hidden="true" />
            Locked: {locked === 1 ? `page ${total}` : `pages ${free + 1}–${total}`} ({locked} of {total})
          </span>
        </div>
      ) : (
        <p className="text-sm text-muted">{total} pages in this document. Enter how many are free to preview.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3. Private link
// ---------------------------------------------------------------------------

function LinkSection({
  setup,
  busy,
  state,
  issuedLink,
  onGenerate,
  onRevoke,
}: {
  setup: ProposalSetup;
  busy: Busy;
  state: StepState;
  issuedLink: { url: string; localOnly: boolean } | null;
  onGenerate: () => Promise<void>;
  onRevoke: () => Promise<void>;
}) {
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const revokeRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);

  // Opening the confirmation moves focus to its safe choice.
  useEffect(() => {
    if (confirmRevoke) keepRef.current?.focus();
  }, [confirmRevoke]);
  const ready = Boolean(setup.document && offerReady(setup));
  const active = setup.status === "active" && setup.link;

  return (
    <Section title="Private link" step={3} state={state}>
      {active ? (
        <p className="flex items-center gap-2.5 text-[15px] text-foreground">
          <span className="relative flex size-2.5 shrink-0 rounded-full bg-accent ring-4 ring-accent-soft" aria-hidden="true" />
          <span>
            Preview link active since{" "}
            <span className="font-medium">{formatDateTime(setup.link!.createdAt)}</span>
          </span>
        </p>
      ) : null}

      {issuedLink ? <IssuedLinkBox link={issuedLink} /> : null}

      {active && !issuedLink ? (
        <p className={hintText}>
          For security the full link is shown only once, when it&apos;s generated: only a fingerprint is stored, so it
          can&apos;t be shown or recovered later. If it&apos;s lost, revoke it and generate a new one. The new link
          replaces it, and the previous link stops working for good.
        </p>
      ) : null}

      {!active && setup.status === "draft" ? (
        <>
          <ul className="space-y-2 text-[15px]">
            <ReadyItem done={Boolean(setup.document)}>Document uploaded and verified</ReadyItem>
            <ReadyItem done={offerReady(setup)}>Preview generated and price saved</ReadyItem>
          </ul>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <button
              type="button"
              className={buttonStyles.primary}
              disabled={!ready || busy !== null}
              onClick={() => onGenerate()}
            >
              {busy === "link" ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Link2 aria-hidden="true" />}
              {busy === "link" ? "Generating…" : "Generate private link"}
            </button>
          </div>
          <p className={hintText}>
            Anyone who has the link can open this proposal&apos;s preview page, so send it only to your client.
            Generating locks the document and price until the link is revoked.
          </p>
        </>
      ) : null}

      {active ? (
        confirmRevoke ? (
          <div className="animate-fade-in space-y-4 rounded-lg border border-danger-border bg-danger-soft p-4 text-[15px]" data-revoke-confirm>
            <p className="flex items-start gap-2 text-danger">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>
                Revoking stops this link immediately; anyone opening it will see “unavailable”. The proposal returns to
                draft so you can change it. A new link can then be generated, and the old one never works again.
              </span>
            </p>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button
                ref={keepRef}
                type="button"
                className={buttonStyles.secondary}
                onClick={() => {
                  setConfirmRevoke(false);
                  // Return focus to the button that opened the confirmation.
                  requestAnimationFrame(() => revokeRef.current?.focus());
                }}
                disabled={busy !== null}
              >
                Keep link
              </button>
              <button
                type="button"
                className={buttonStyles.destructive}
                disabled={busy !== null}
                onClick={async () => {
                  await onRevoke();
                  setConfirmRevoke(false);
                }}
              >
                {busy === "revoke" ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Unlink aria-hidden="true" />}
                {busy === "revoke" ? "Revoking…" : "Revoke link"}
              </button>
            </div>
          </div>
        ) : (
          <button
            ref={revokeRef}
            type="button"
            className={buttonStyles.secondary}
            disabled={busy !== null}
            onClick={() => setConfirmRevoke(true)}
          >
            <Unlink aria-hidden="true" />
            Revoke link…
          </button>
        )
      ) : null}
    </Section>
  );
}

const hintText = "text-sm leading-6 text-subtle";

function joinFormats(labels: string[]) {
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}`;
}

function ReadyItem({ done, children }: { done: boolean; children: ReactNode }) {
  return (
    <li className="flex items-center gap-2">
      {done ? (
        <span className="flex size-4 items-center justify-center rounded-full bg-success-soft text-success" aria-hidden="true">
          <Check className="size-3" strokeWidth={3} />
        </span>
      ) : (
        <span className="size-4 rounded-full border border-border-strong" aria-hidden="true" />
      )}
      <span className={done ? "text-foreground" : "text-muted"}>{children}</span>
      <span className="sr-only">{done ? "(done)" : "(not done)"}</span>
    </li>
  );
}

function IssuedLinkBox({ link }: { link: { url: string; localOnly: boolean } }) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(link.url);
      setCopyState("copied");
    } catch {
      inputRef.current?.focus();
      inputRef.current?.select();
      setCopyState("failed");
    }
  }

  return (
    <div className="animate-fade-in space-y-3 rounded-lg border border-accent-border bg-accent-soft p-4" data-issued-link>
      <label htmlFor={inputId} className="block text-[15px] font-medium text-accent-strong">
        Private link (copy it now)
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          ref={inputRef}
          id={inputId}
          readOnly
          value={link.url}
          onFocus={(event) => event.currentTarget.select()}
          className={`${controlStyles} h-12 px-4 font-mono text-sm`}
        />
        <button type="button" className={buttonStyles.primary} onClick={copy}>
          {copyState === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copyState === "copied" ? "Copied" : "Copy link"}
        </button>
      </div>
      <p className="text-sm leading-6 text-accent-strong" role="status">
        {copyState === "copied"
          ? "Link copied to the clipboard."
          : copyState === "failed"
            ? "Couldn't copy automatically. The link is selected: press Ctrl+C (⌘C on Mac)."
            : "This is the only time the full link is shown. It can't be displayed again later."}
      </p>
      {link.localOnly ? (
        <p className={`${calloutStyles.warning} flex items-start gap-2`}>
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>
            Local-only link: it points to this computer ({new URL(link.url).host}), so clients can&apos;t open it.
            Links for clients must be generated from the live portal.
          </span>
        </p>
      ) : null}
    </div>
  );
}
