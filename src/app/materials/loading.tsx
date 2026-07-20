import { Package } from "lucide-react";
import { DashboardSkeleton } from "@/components/ui/page-states";

export default function MaterialsLoading() {
  return <DashboardSkeleton title="Material Sales" icon={Package} kpiCount={2} />;
}
