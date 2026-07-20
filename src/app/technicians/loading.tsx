import { Gauge } from "lucide-react";
import { DashboardSkeleton } from "@/components/ui/page-states";

export default function TechniciansLoading() {
  return <DashboardSkeleton title="Technician Performance" icon={Gauge} kpiCount={4} />;
}
