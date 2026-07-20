"use client";

import { DashboardErrorState } from "@/components/ui/page-states";

export default function CommissionsError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <DashboardErrorState
      heading="Commission dashboard could not load"
      detail="The commission period or annual summary request failed before the dashboard could render."
      onRetry={reset}
    />
  );
}
