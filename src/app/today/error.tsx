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
          <h1 className="h1">Today&apos;s Profitability</h1>
          <p className="sub">The current Pacific-day profitability view could not be rendered.</p>
        </div>
      </div>
      <Card>
        <CardBody>
          <StateError onRetry={() => reset()}>The app-owned profitability feed could not be loaded.</StateError>
        </CardBody>
      </Card>
    </div>
  );
}
