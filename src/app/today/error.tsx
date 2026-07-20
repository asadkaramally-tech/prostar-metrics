"use client";

import { Card, CardBody, StateError } from "@/components/reset";

/**
 * /today route error boundary — the approved error treatment: honest message
 * plus a real retry.
 */
export default function TodayError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="dashboard-content">
      <div className="top">
        <div>
          <div className="eyebrow">Operations</div>
          <h1 className="h1">Today</h1>
          <p className="sub">The live month-to-date view could not be rendered.</p>
        </div>
      </div>
      <Card>
        <CardBody>
          <StateError onRetry={() => reset()}>Live Simpro pull failed.</StateError>
        </CardBody>
      </Card>
    </div>
  );
}
