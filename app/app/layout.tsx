import { AppSidebar } from "@/components/AppSidebar";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="shell">
      <AppSidebar />
      <main className="main">{children}</main>
    </div>
  );
}
