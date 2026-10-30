"use client";

import "./pdf-text-layer.css";

import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Download,
  Link2Off,
  Loader2,
  Lock,
  Maximize,
  Minimize,
  MoveHorizontal,
  RectangleVertical,
  RotateCw,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  RenderTask,
  TextLayer,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";

// Client PDF viewer. What it fetches is decided by the server page:
//   - "preview": ONLY the separate preview PDF from /p/<token>/preview;
//   - "full": the complete document, either a Full Access link's
//     /p/<token>/document or a purchase's /purchase/<ref>/document (which
//     re-checks this browser's paid access, so it sends the same-origin
//     session cookie).
// Each endpoint re-checks access on every request. Renders ONE page at a
// time with PDF.js (never the whole document), so even a 300-page file
// stays light. The library is imported on demand, so no other route ships
// it; its worker and data files are served from this origin
// (public/pdfjs/<version>/, see scripts/copy-pdfjs-assets.mjs).
//
// The bytes are handed to PDF.js directly (no object URLs). Each page
// render cancels the previous one and only swaps the canvas in once it has
// finished, so fast navigation, zooming, resizing or entering full screen
// never shows a stale or stretched page. Unmounting or retrying destroys
// the document and terminates its worker.
//
// Reading controls: previous/next and a page box, fit to width (default),
// fit page, zoom, and full screen (the Fullscreen API where available;
// otherwise a fixed full-window overlay, closed with Esc or the same
// button). A "Download PDF" link appears only when the server passes
// `downloadUrl` (a verified purchase; the route re-checks access).

type Pdfjs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

type LoadState =
  | { status: "loading" }
  | { status: "ready"; pdfjs: Pdfjs; doc: PDFDocumentProxy }
  | { status: "unavailable" }
  | { status: "error"; message: string };

// "fit": fit to width; "page": the whole page fits the visible area.
type Zoom = { mode: "fit" } | { mode: "page" } | { mode: "manual"; value: number };

type Expanded = "none" | "native" | "fallback";

// PDF points (1/72 in) to CSS pixels (1/96 in): "100%" is the printed size.
const CSS_UNITS = 96 / 72;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const ZOOM_STEP = 1.25;
// Caps the canvas backing store (~16.7 MP) so very large pages or high
// zoom can't exhaust memory; such pages render at a lower pixel density.
const MAX_CANVAS_PIXELS = 4096 * 4096;
const LOAD_TIMEOUT_MS = 30_000;
// Narrowest width/height the fit modes scale to, for extremely small stages.
const MIN_FIT_WIDTH = 100;
const MIN_FIT_HEIGHT = 160;
// Outside full screen, "fit page" fits the page into the window minus room
// for the toolbar and some of the page around it.
const WINDOW_CHROME = 150;

function messagesFor(noun: string) {
  return {
    network: `We couldn't load the ${noun}. Check your connection and try again.`,
    server: `The ${noun} is temporarily unavailable. Please try again in a moment.`,
    timeout: `Loading the ${noun} is taking too long. Please try again.`,
    render: `The ${noun} couldn't be displayed. Please try again.`,
    busy: `This ${noun} was requested too many times in a short period. Wait a moment, then try again.`,
  };
}

const PREVIEW_MESSAGES = messagesFor("preview");
const DOCUMENT_MESSAGES = messagesFor("document");

// Fullscreen API with the WebKit prefix (older Safari / iPadOS).
type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type FullscreenElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

function fullscreenElement(): Element | null {
  const doc = document as FullscreenDocument;
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

async function requestNativeFullscreen(element: HTMLElement): Promise<boolean> {
  const doc = document as FullscreenDocument;
  const target = element as FullscreenElement;
  try {
    if (doc.fullscreenEnabled && typeof target.requestFullscreen === "function") {
      await target.requestFullscreen({ navigationUI: "hide" });
      return true;
    }
    if (doc.webkitFullscreenEnabled && typeof target.webkitRequestFullscreen === "function") {
      await target.webkitRequestFullscreen();
      return true;
    }
  } catch {
    // Refused (permissions policy, iframe, user gesture): use the fallback.
  }
  return false;
}

async function exitNativeFullscreen() {
  const doc = document as FullscreenDocument;
  try {
    if (typeof doc.exitFullscreen === "function") await doc.exitFullscreen();
    else await doc.webkitExitFullscreen?.();
  } catch {
    // Already left.
  }
}

export function PreviewViewer({
  previewUrl,
  freePages,
  totalPages,
  variant = "preview",
  downloadUrl = null,
}: {
  previewUrl: string;
  freePages: number;
  totalPages: number;
  // "full": the complete document (all pages, no locked notice).
  variant?: "preview" | "full";
  // Purchased documents only: the authorized download route.
  downloadUrl?: string | null;
}) {
  const full = variant === "full";
  const MESSAGES = full ? DOCUMENT_MESSAGES : PREVIEW_MESSAGES;
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageInput, setPageInput] = useState<string | null>(null);
  const [zoom, setZoom] = useState<Zoom>({ mode: "fit" });
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [windowHeight, setWindowHeight] = useState(0);
  const [expanded, setExpanded] = useState<Expanded>("none");
  const [rendered, setRendered] = useState<{ key: string; scale: number } | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [renderAttempt, setRenderAttempt] = useState(0);

  const sectionRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const pageHostRef = useRef<HTMLDivElement>(null);

  // Never navigate past the preview, even if a file had more pages.
  const pageCount = load.status === "ready" ? Math.min(load.doc.numPages, freePages) : freePages;
  const lockedPages = totalPages - freePages;

  // --- Load the document (again on every retry) ----------------------------
  useEffect(() => {
    const messages = full ? DOCUMENT_MESSAGES : PREVIEW_MESSAGES;
    let disposed = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    const controller = new AbortController();
    const fail = (state: LoadState) => {
      if (!disposed) setLoad(state);
    };
    const timer = window.setTimeout(() => {
      controller.abort();
      void loadingTask?.destroy();
      fail({ status: "error", message: messages.timeout });
      disposed = true;
    }, LOAD_TIMEOUT_MS);

    (async () => {
      let response: Response;
      try {
        response = await fetch(previewUrl, {
          cache: "no-store",
          // A purchased document is authorized by this browser's paid-access
          // cookie; links themselves need no credentials at all.
          credentials: full ? "same-origin" : "omit",
          headers: { Accept: "application/pdf" },
          signal: controller.signal,
        });
      } catch {
        return fail({ status: "error", message: messages.network });
      }
      if (response.status === 404) return fail({ status: "unavailable" });
      if (response.status === 429) return fail({ status: "error", message: messages.busy });
      if (!response.ok) return fail({ status: "error", message: messages.server });

      let data: Uint8Array;
      try {
        data = new Uint8Array(await response.arrayBuffer());
      } catch {
        return fail({ status: "error", message: messages.network });
      }
      if (disposed) return;

      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const assets = `/pdfjs/${pdfjs.version}/`;
      pdfjs.GlobalWorkerOptions.workerSrc = `${assets}pdf.worker.min.mjs`;
      loadingTask = pdfjs.getDocument({
        data,
        cMapUrl: `${assets}cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${assets}standard_fonts/`,
        wasmUrl: `${assets}wasm/`,
        iccUrl: `${assets}iccs/`,
        enableXfa: false,
        verbosity: pdfjs.VerbosityLevel.ERRORS,
      });
      const doc = await loadingTask.promise;
      if (disposed) return;
      window.clearTimeout(timer);
      setLoad({ status: "ready", pdfjs, doc });
    })().catch(() => fail({ status: "error", message: messages.render }));

    return () => {
      disposed = true;
      window.clearTimeout(timer);
      controller.abort();
      // Destroys the document and terminates its dedicated worker.
      void loadingTask?.destroy();
    };
  }, [previewUrl, attempt, full]);

  // --- Track the stage size and window height (fit modes, resizes) ---------
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let frame = 0;
    const observer = new ResizeObserver(([entry]) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const width = Math.floor(entry.contentRect.width);
        const height = Math.floor(entry.contentRect.height);
        setStageSize((current) =>
          Math.abs(current.width - width) >= 1 || Math.abs(current.height - height) >= 1 ? { width, height } : current,
        );
      });
    });
    observer.observe(stage);
    let windowFrame = 0;
    const onResize = () => {
      cancelAnimationFrame(windowFrame);
      windowFrame = requestAnimationFrame(() => setWindowHeight(window.innerHeight));
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(windowFrame);
      observer.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, []);

  // --- Full screen -----------------------------------------------------------
  useEffect(() => {
    const section = sectionRef.current;
    const onChange = () => {
      const active = fullscreenElement() !== null && fullscreenElement() === section;
      setExpanded((current) => (active ? "native" : current === "native" ? "none" : current));
    };
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
      // Leaving the page while in full screen: hand the screen back.
      if (section && fullscreenElement() === section) void exitNativeFullscreen();
    };
  }, []);

  // The fallback overlay: lock page scrolling behind it; Esc closes it.
  useEffect(() => {
    if (expanded !== "fallback") return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setExpanded("none");
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", onKey);
    };
  }, [expanded]);

  const toggleFullscreen = useCallback(async () => {
    if (expanded === "native") return exitNativeFullscreen();
    if (expanded === "fallback") return setExpanded("none");
    const section = sectionRef.current;
    if (section && (await requestNativeFullscreen(section))) return;
    setExpanded("fallback");
  }, [expanded]);

  const isExpanded = expanded !== "none";
  const fitHeight = isExpanded ? stageSize.height : Math.max(windowHeight - WINDOW_CHROME, MIN_FIT_HEIGHT);

  // Size only matters for the fit modes; a manual zoom ignores resizes.
  const layoutKey =
    stageSize.width === 0
      ? ""
      : zoom.mode === "fit"
        ? `w${stageSize.width}`
        : zoom.mode === "page"
          ? `p${stageSize.width}x${fitHeight}`
          : "m";
  const zoomKey = zoom.mode === "manual" ? zoom.value.toFixed(4) : zoom.mode;
  const renderKey = `${attempt}:${pageNumber}:${zoomKey}:${layoutKey}:${renderAttempt}`;

  // --- Render the current page on demand ------------------------------------
  useEffect(() => {
    if (load.status !== "ready" || layoutKey === "") return;
    const { pdfjs, doc } = load;
    const host = pageHostRef.current;
    if (!host) return;

    let cancelled = false;
    let renderTask: RenderTask | null = null;
    let textLayer: TextLayer | null = null;
    let canvas: HTMLCanvasElement | null = null;

    (async () => {
      const page = await doc.getPage(pageNumber);
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      // The stage size is its content box (padding already excluded).
      const widthScale = Math.max(stageSize.width, MIN_FIT_WIDTH) / base.width;
      const heightScale = Math.max(fitHeight, MIN_FIT_HEIGHT) / base.height;
      const maxScale = MAX_ZOOM * CSS_UNITS;
      const scale =
        zoom.mode === "fit"
          ? Math.min(widthScale, maxScale)
          : zoom.mode === "page"
            ? Math.min(widthScale, heightScale, maxScale)
            : zoom.value * CSS_UNITS;
      const viewport = page.getViewport({ scale });

      const pixelRatio = Math.min(
        window.devicePixelRatio || 1,
        Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)),
      );
      canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(viewport.width * pixelRatio));
      canvas.height = Math.max(1, Math.floor(viewport.height * pixelRatio));
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      canvas.className = "block";
      canvas.setAttribute("aria-hidden", "true");

      renderTask = page.render({
        canvas,
        viewport,
        transform: pixelRatio !== 1 ? [pixelRatio, 0, 0, pixelRatio, 0, 0] : undefined,
      });
      await renderTask.promise;
      if (cancelled) return;

      const textDiv = document.createElement("div");
      textDiv.className = "textLayer";
      textLayer = new pdfjs.TextLayer({
        textContentSource: page.streamTextContent(),
        container: textDiv,
        viewport,
      });

      // Swap in the finished page and release the previous canvas memory.
      for (const old of host.querySelectorAll("canvas")) {
        old.width = 0;
        old.height = 0;
      }
      host.style.setProperty("--total-scale-factor", String(viewport.scale));
      host.style.width = canvas.style.width;
      host.style.height = canvas.style.height;
      host.replaceChildren(canvas, textDiv);
      canvas = null;
      setPageError(null);
      setRendered({ key: renderKey, scale });

      // Selectable text is a progressive enhancement: a failure here leaves
      // the rendered page in place.
      await textLayer.render().catch(() => undefined);
    })().catch((error: unknown) => {
      if (cancelled || error instanceof pdfjs.RenderingCancelledException) return;
      setPageError(MESSAGES.render);
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
    };
    // The stage size is read through layoutKey/renderKey on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, pageNumber, zoomKey, layoutKey, renderAttempt, renderKey]);

  const rendering = load.status === "ready" && rendered?.key !== renderKey && !pageError;
  // Zoom steps build on the REQUESTED level (not the last finished render),
  // so quick repeated clicks add up while pages are still rendering.
  const fittedZoom = (rendered?.scale ?? CSS_UNITS) / CSS_UNITS;
  const zoomLevel = zoom.mode === "manual" ? zoom.value : fittedZoom;
  const zoomPercent = Math.round(zoomLevel * 100);

  const goTo = useCallback(
    (target: number) => setPageNumber(Math.min(Math.max(target, 1), pageCount)),
    [pageCount],
  );
  const zoomBy = useCallback(
    (factor: number) =>
      setZoom((current) => {
        const from = current.mode === "manual" ? current.value : fittedZoom;
        const next = Math.min(Math.max(from * factor, MIN_ZOOM), MAX_ZOOM);
        return { mode: "manual", value: Math.round(next * 100) / 100 };
      }),
    [fittedZoom],
  );
  const canZoomIn = zoomPercent < MAX_ZOOM * 100;
  const canZoomOut = zoomPercent > MIN_ZOOM * 100;

  function retry() {
    setLoad({ status: "loading" });
    setRendered(null);
    setPageError(null);
    setAttempt((value) => value + 1);
  }

  function submitPage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = Number(pageInput);
    if (Number.isInteger(value)) goTo(value);
    setPageInput(null);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (load.status !== "ready" || event.altKey || event.ctrlKey || event.metaKey) return;
    const actions: Record<string, () => void> = {
      ArrowRight: () => goTo(pageNumber + 1),
      PageDown: () => goTo(pageNumber + 1),
      ArrowLeft: () => goTo(pageNumber - 1),
      PageUp: () => goTo(pageNumber - 1),
      Home: () => goTo(1),
      End: () => goTo(pageCount),
      "+": () => canZoomIn && zoomBy(ZOOM_STEP),
      "=": () => canZoomIn && zoomBy(ZOOM_STEP),
      "-": () => canZoomOut && zoomBy(1 / ZOOM_STEP),
    };
    const action = actions[event.key];
    if (action) {
      event.preventDefault();
      action();
    }
  }

  const button =
    "inline-flex h-9 min-w-9 select-none items-center justify-center gap-1.5 rounded-md border border-border-strong bg-surface px-2 " +
    "text-sm font-medium text-foreground shadow-card transition-[background-color,border-color,color,transform] duration-150 " +
    "hover:border-accent-border hover:bg-accent-soft hover:text-accent-strong active:translate-y-px " +
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent " +
    "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border-strong disabled:hover:bg-surface disabled:hover:text-foreground " +
    "aria-pressed:border-accent aria-pressed:bg-accent-soft aria-pressed:text-accent-strong";
  const primaryLink =
    "inline-flex h-9 select-none items-center justify-center gap-1.5 rounded-md border border-accent bg-accent px-2.5 " +
    "text-sm font-semibold text-accent-foreground shadow-card transition-[background-color,transform] duration-150 " +
    "hover:bg-accent-hover active:translate-y-px focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

  const ready = load.status === "ready";

  return (
    <section
      ref={sectionRef}
      aria-label={full ? "Proposal document" : "Proposal preview"}
      className={
        isExpanded
          ? // Native full screen or the fallback overlay: the viewer fills the screen.
            `flex flex-col overflow-hidden bg-surface ${expanded === "fallback" ? "fixed inset-0 z-50" : "h-full w-full"}`
          : "overflow-hidden rounded-xl border border-border bg-surface shadow-card"
      }
      data-viewer-state={load.status}
      data-expanded={expanded}
      {...(expanded === "fallback" ? { role: "dialog", "aria-modal": true } : {})}
    >
      <div
        role="toolbar"
        aria-label={full ? "Document controls" : "Preview controls"}
        aria-controls="preview-stage"
        className="flex shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-2 border-b border-border bg-surface px-2 py-2 sm:justify-between sm:gap-x-4 sm:px-3 sm:py-2.5"
      >
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className={button}
            onClick={() => goTo(pageNumber - 1)}
            disabled={!ready || pageNumber <= 1}
            aria-label="Previous page"
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
          </button>
          <p className="min-w-32 text-center text-sm leading-tight tabular-nums text-muted sm:min-w-36" aria-live="polite" data-page-status>
            {ready && full ? (
              <>
                Page <span className="font-semibold text-foreground">{pageNumber}</span> of {pageCount}
              </>
            ) : ready ? (
              <>
                Preview page <span className="font-semibold text-foreground">{pageNumber}</span> of {pageCount}
                {/* The free preview is the document's first pages, so preview page N is document page N. */}
                <span className="block text-xs text-subtle" data-document-page>
                  <span className="sr-only">, </span>Document page {pageNumber} of {totalPages}
                </span>
              </>
            ) : (
              <span className="text-subtle">{full ? "Document" : "Preview"}</span>
            )}
          </p>
          <button
            type="button"
            className={button}
            onClick={() => goTo(pageNumber + 1)}
            disabled={!ready || pageNumber >= pageCount}
            aria-label="Next page"
          >
            <ChevronRight className="size-4" aria-hidden="true" />
          </button>
          {pageCount > 2 ? (
            <form onSubmit={submitPage} className="hidden items-center sm:flex" data-page-jump>
              <label className="sr-only" htmlFor="viewer-page-input">
                Go to page (1 to {pageCount})
              </label>
              <input
                id="viewer-page-input"
                type="number"
                inputMode="numeric"
                min={1}
                max={pageCount}
                value={pageInput ?? String(pageNumber)}
                disabled={!ready}
                onChange={(event) => setPageInput(event.target.value)}
                onBlur={() => setPageInput(null)}
                className="h-9 w-16 rounded-md border border-border-strong bg-surface px-2 text-center text-sm tabular-nums text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:opacity-40"
              />
            </form>
          ) : null}
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className={button}
            onClick={() => zoomBy(1 / ZOOM_STEP)}
            disabled={!ready || !canZoomOut}
            aria-label="Zoom out"
          >
            <ZoomOut className="size-4" aria-hidden="true" />
          </button>
          <span className="w-12 text-center text-sm tabular-nums text-muted" aria-live="polite" data-zoom>
            {ready && (zoom.mode === "manual" || rendered) ? `${zoomPercent}%` : "–"}
            <span className="sr-only"> zoom</span>
          </span>
          <button
            type="button"
            className={button}
            onClick={() => zoomBy(ZOOM_STEP)}
            disabled={!ready || !canZoomIn}
            aria-label="Zoom in"
          >
            <ZoomIn className="size-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            className={button}
            onClick={() => setZoom({ mode: "fit" })}
            disabled={!ready}
            aria-pressed={zoom.mode === "fit"}
            aria-label="Fit to width"
          >
            <MoveHorizontal className="size-4" aria-hidden="true" />
            <span className="hidden lg:inline">Fit width</span>
          </button>
          <button
            type="button"
            className={button}
            onClick={() => setZoom({ mode: "page" })}
            disabled={!ready}
            aria-pressed={zoom.mode === "page"}
            aria-label="Fit page"
          >
            <RectangleVertical className="size-4" aria-hidden="true" />
            <span className="hidden lg:inline">Fit page</span>
          </button>
          <button
            type="button"
            className={button}
            onClick={() => void toggleFullscreen()}
            aria-pressed={isExpanded}
            aria-label={isExpanded ? "Exit full screen" : "Full screen"}
            data-fullscreen-toggle
          >
            {isExpanded ? (
              <Minimize className="size-4" aria-hidden="true" />
            ) : (
              <Maximize className="size-4" aria-hidden="true" />
            )}
          </button>
        </div>

        {downloadUrl ? (
          <a href={downloadUrl} download className={primaryLink} data-download="pdf">
            <Download className="size-4" aria-hidden="true" />
            Download PDF
          </a>
        ) : null}
      </div>

      <div
        id="preview-stage"
        ref={stageRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        aria-label={`${full ? "Document" : "Preview"} page. Use the arrow keys to change pages and + or − to zoom.`}
        className={`relative bg-surface-sunken px-3 py-4 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent sm:px-4 sm:py-5 ${
          isExpanded ? "min-h-0 flex-1 overflow-auto" : "overflow-x-auto"
        }`}
      >
        {load.status === "loading" ? (
          <Notice>
            <p role="status" className="flex items-center gap-2 text-sm text-muted">
              <Loader2 className="size-4 animate-spin text-accent" aria-hidden="true" />
              {full ? "Loading document…" : "Loading preview…"}
            </p>
          </Notice>
        ) : null}

        {load.status === "unavailable" ? (
          <Notice>
            <Link2Off className="size-6 text-subtle" aria-hidden="true" />
            <p role="alert" className="text-sm font-medium text-foreground">
              {full ? "This document isn't available." : "This link is no longer available."}
            </p>
            <p className="max-w-sm text-center text-sm text-muted">
              {full
                ? "Access may have ended. Please contact the person who sent you the link."
                : "It may have been withdrawn. Please contact the person who sent it to you."}
            </p>
            <button type="button" className={button} onClick={retry}>
              <RotateCw className="size-4" aria-hidden="true" />
              Check again
            </button>
          </Notice>
        ) : null}

        {load.status === "error" ? (
          <Notice>
            <AlertTriangle className="size-6 text-warning" aria-hidden="true" />
            <p role="alert" className="max-w-sm text-center text-sm text-foreground">
              {load.message}
            </p>
            <button type="button" className={button} onClick={retry}>
              <RotateCw className="size-4" aria-hidden="true" />
              Try again
            </button>
          </Notice>
        ) : null}

        {ready ? (
          <div className="flex w-max min-w-full flex-col items-center gap-3">
            <div className="relative">
              <div
                ref={pageHostRef}
                role="group"
                aria-label={
                  full
                    ? `Page ${pageNumber} of ${pageCount}`
                    : `Preview page ${pageNumber} of ${pageCount} (document page ${pageNumber} of ${totalPages})`
                }
                className="pdf-page relative bg-surface shadow-sm ring-1 ring-border"
                data-rendered-page={rendered?.key === renderKey ? pageNumber : undefined}
              />
              {rendering && rendered ? (
                <div className="pointer-events-none absolute inset-0 flex items-start justify-end p-2">
                  <span className="inline-flex items-center gap-1 rounded bg-surface/90 px-2 py-1 text-xs text-muted shadow-sm">
                    <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                    Rendering…
                  </span>
                </div>
              ) : null}
              {rendering && !rendered ? (
                <p role="status" className="flex items-center gap-2 py-16 text-sm text-muted">
                  <Loader2 className="size-4 animate-spin text-accent" aria-hidden="true" />
                  Rendering page…
                </p>
              ) : null}
            </div>

            {pageError ? (
              <div className="flex flex-col items-center gap-2 py-4">
                <p role="alert" className="text-sm text-foreground">
                  {pageError}
                </p>
                <button type="button" className={button} onClick={() => setRenderAttempt((v) => v + 1)}>
                  <RotateCw className="size-4" aria-hidden="true" />
                  Try again
                </button>
              </div>
            ) : null}

            {!full && pageNumber === pageCount && lockedPages > 0 ? (
              <p className="flex max-w-md items-center gap-2 rounded-md border border-accent-border bg-accent-soft px-3 py-2 text-sm text-accent-strong">
                <Lock className="size-4 shrink-0" aria-hidden="true" />
                End of the free preview. The remaining {lockedPages} {lockedPages === 1 ? "page is" : "pages are"} locked.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return <div className="flex min-h-72 flex-col items-center justify-center gap-3 py-10">{children}</div>;
}
