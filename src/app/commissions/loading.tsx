import { ReceiptText } from "lucide-react";
import { DashboardSkeleton } from "@/components/ui/page-states";

export default function CommissionsLoading() {
  return <DashboardSkeleton title="Technician Commissions" icon={ReceiptText} kpiCount={4} />;
}
