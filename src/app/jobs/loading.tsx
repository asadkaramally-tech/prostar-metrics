import { BriefcaseBusiness } from "lucide-react";
import { DashboardSkeleton } from "@/components/ui/page-states";

export default function JobsLoading() {
  return <DashboardSkeleton title="Job Metrics" icon={BriefcaseBusiness} kpiCount={4} />;
}
