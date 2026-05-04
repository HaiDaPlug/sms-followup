import { LoginForm } from "@/components/LoginForm";

export const metadata = { title: "Logga in – SMS-påminnelser" };

export default async function LoginPage({
  searchParams
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  return (
    <div style={{
      minHeight: "100vh",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "var(--surface-sub)",
    }}>
      <div style={{
        width: "100%",
        maxWidth: 380,
        padding: "0 16px",
      }}>
        <div style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          padding: "36px 32px 32px",
          boxShadow: "0 4px 24px rgba(7,59,44,0.07)",
        }}>
          <div style={{ marginBottom: 28, textAlign: "center" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/osteopaticentrum.svg"
              alt="Osteopaticentrum"
              style={{ height: 36, marginBottom: 20 }}
            />
            <h1 style={{
              fontFamily: "var(--font-head)",
              fontSize: 20,
              fontWeight: 700,
              color: "var(--text)",
              marginBottom: 4,
            }}>
              Logga in
            </h1>
            <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
              SMS-påminnelsesystem
            </p>
          </div>

          {error === "unauthorized" && (
            <div style={{
              background: "var(--red-bg)",
              border: "1px solid var(--red-border)",
              borderRadius: "var(--radius-sm)",
              padding: "10px 14px",
              fontSize: 13,
              color: "var(--red)",
              marginBottom: 18,
            }}>
              Felaktigt e-post eller lösenord.
            </div>
          )}

          <LoginForm next={next} />
        </div>
      </div>
    </div>
  );
}
