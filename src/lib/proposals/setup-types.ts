import type { SourceFormat, UploadFormats } from "@/lib/documents/formats";

import type { CurrencyCode } from "./currencies";

// Data the "Manage Document" dialog works with. Storage paths and owner ids are
// never sent to the browser; revisions are opaque version tokens used to
// detect edits made elsewhere in the meantime.

export type ProposalSetup = {
  id: string;
  title: string;
  clientName: string;
  ownerName: string | null;
  status: "draft" | "active" | "archived";
  document: {
    revision: string;
    fileName: string | null;
    sizeBytes: number | null;
    totalPages: number;
    // null: the upload was a PDF. Otherwise the original (source) format,
    // converted on the server to the canonical PDF.
    sourceFormat: SourceFormat | null;
  } | null;
  preview: { revision: string; pages: number } | null;
  offer: {
    freePages: number | null;
    priceMinor: number | null;
    currency: CurrencyCode | null;
  };
  link: { createdAt: string } | null;
  // Upload formats this server accepts right now.
  upload: UploadFormats & { maxMb: number };
};

export type SetupResult<T> =
  | { ok: true; data: T; message: string }
  | {
      ok: false;
      message: string;
      fieldErrors?: Partial<Record<"file" | "freePages" | "price" | "currency", string>>;
      // The proposal changed elsewhere; reload before trying again.
      stale?: boolean;
    };

export type UploadTicket = { revision: string; path: string; token: string; contentType: string };

export type IssuedLink = { setup: ProposalSetup; url: string; localOnly: boolean };
