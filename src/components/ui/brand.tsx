import { FileText } from "lucide-react";

// Blue square with a document icon, used next to the product name.
export function BrandMark({ size = "default" }: { size?: "default" | "large" }) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center bg-accent text-accent-foreground shadow-accent ${
        size === "large" ? "size-10 rounded-xl" : "size-8 rounded-lg"
      }`}
      aria-hidden="true"
    >
      <FileText className={size === "large" ? "size-5" : "size-4"} />
    </span>
  );
}
