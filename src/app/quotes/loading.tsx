import { FileText } from "lucide-react";
import { DashboardSkeleton } from "@/components/ui/page-states";

export default function QuotesLoading() {
  return <DashboardSkeleton title="Quote Metrics" icon={FileText} kpiCount={4} />;
}
