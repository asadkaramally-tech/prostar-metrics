/* Inline stroke icons exactly as they appear in the approved mockups
   (today.html needs-attention rows and state-treatment strips). */

export type FiTone = "warn" | "down" | "info";

export function FiIcon({ tone }: { tone: FiTone }) {
  if (tone === "warn") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} width={13} height={13}>
        <path d="M12 3.5 2.8 19.5h18.4Z" />
        <path d="M12 9.8v4.4M12 16.9v.1" />
      </svg>
    );
  }
  if (tone === "down") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} width={13} height={13}>
        <path d="M12 4.5v13M6.2 12.2l5.8 5.8 5.8-5.8" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} width={13} height={13}>
      <circle cx={12} cy={12} r={8.6} />
      <path d="M12 11v5.4M12 7.4v.1" />
    </svg>
  );
}

export function CaretIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} width={14} height={14}>
      <path d="M9.2 5.2 16 12l-6.8 6.8" />
    </svg>
  );
}

export function ErrorMarkIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} width={12} height={12}>
      <path d="M12 5v9M12 18.4v.1" />
    </svg>
  );
}
