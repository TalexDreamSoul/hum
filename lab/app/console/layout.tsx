import { ConsoleShell } from "@/components/console/console-shell";
import { requirePageUser } from "@/lib/server/auth";

export const dynamic = "force-dynamic";


export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePageUser();
  return (
    <ConsoleShell displayName={user.displayName} role={user.role}>
      {children}
    </ConsoleShell>
  );
}
