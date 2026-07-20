"use client";

import { DashboardErrorState } from "@/components/ui/page-states";

export default function QuotesError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <DashboardErrorState
      heading="Quote Metrics could not load"
      detail="The request failed before a persisted read model could be rendered."
      onRetry={reset}
    />
  );
}
