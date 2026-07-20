"use client";

import { DashboardErrorState } from "@/components/ui/page-states";

export default function TechniciansError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <DashboardErrorState
      heading="Technician Performance could not load"
      detail="The request failed before a persisted read model could be rendered."
      onRetry={reset}
    />
  );
}
