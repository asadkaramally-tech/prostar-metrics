import { notFound } from "next/navigation";
import { Suspense } from "react";
import { DataHealthDrawer } from "@/components/data-health-drawer";
import { SidebarNav } from "@/components/sidebar-nav";
import { getCurrentUser, type CurrentUser } from "@/lib/auth/roles";
import { getOwnerDataHealth } from "@/lib/store/data-health";
import { cachedPageLoad } from "@/lib/store/page-cache";

export async function AppShell({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user.roles.some((role) => role === "admin" || role === "finance")) {
    notFound();
  }
  const isAdmin = user.roles.includes("admin");

  return (
    <div className="app">
      <header className="rail">
        <div className="brand">
          {/* eslint-disable-next-line @next/next/no-img-element -- static brand asset */}
          <img src="/prostar-logo-white.png" alt="Pro Star Mechanical" />
          <div>
            <div className="bsub">Metrics</div>
          </div>
        </div>
        <SidebarNav />
        <div className="owner">
          <div className="av">{userInitials(user.displayName)}</div>
          <div>
            <b>{user.displayName}</b>
            <span>Owner · {isAdmin ? "Admin" : "Finance"}</span>
          </div>
        </div>
      </header>

      <main className="main">{children}</main>

      {isAdmin ? (
        <Suspense fallback={<DataHealthDrawer state="loading" />}>
          <OwnerDataHealth user={user} />
        </Suspense>
      ) : null}
    </div>
  );
}

/* Approved owner block shows a single initial ("A"). */
function userInitials(displayName: string) {
  return displayName.trim()[0]?.toUpperCase() || "P";
}

async function OwnerDataHealth({ user }: { user: CurrentUser }) {
  let model = null;
  let loadFailed = false;
  try {
    model = await cachedPageLoad("owner-data-health", 60_000, () => getOwnerDataHealth(user));
  } catch (error) {
    console.error("Unable to load owner data health", error);
    loadFailed = true;
  }

  if (loadFailed) {
    return <DataHealthDrawer state="error" message="The app-owned metrics store could not be read." />;
  }
  return model ? <DataHealthDrawer state="ready" model={model} /> : null;
}
