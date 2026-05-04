import { LoginForm } from "@/components/LoginForm";
import { LoginLeftPanel } from "@/components/LoginLeftPanel";

export const metadata = { title: "Logga in – Osteopaticentrum" };

export default async function LoginPage({
  searchParams
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next } = await searchParams;

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400&family=DM+Sans:wght@300;400;500&display=swap');

        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        .login-shell {
          min-height: 100vh;
          display: grid;
          grid-template-columns: 1fr 1fr;
          font-family: 'DM Sans', sans-serif;
        }

        /* ── Left panel ── */
        .login-left {
          position: relative;
          background: #073B2C;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          padding: 52px 56px;
          overflow: hidden;
        }

        .login-left-noise {
          position: absolute;
          inset: 0;
          background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.04'/%3E%3C/svg%3E");
          pointer-events: none;
          opacity: 0.6;
        }

        .login-left-glow {
          position: absolute;
          top: -120px;
          right: -120px;
          width: 480px;
          height: 480px;
          background: radial-gradient(circle, rgba(91,191,181,0.18) 0%, transparent 65%);
          pointer-events: none;
        }

        .login-left-glow-2 {
          position: absolute;
          bottom: -80px;
          left: -80px;
          width: 360px;
          height: 360px;
          background: radial-gradient(circle, rgba(91,191,181,0.10) 0%, transparent 65%);
          pointer-events: none;
        }

        .login-logo {
          position: relative;
          z-index: 1;
          opacity: 0;
          animation: fadeUp 0.7s cubic-bezier(0.22,1,0.36,1) 0.1s forwards;
        }
        .login-logo img {
          height: 64px;
          filter: brightness(0) invert(1);
          opacity: 0.92;
        }

        .login-left-body {
          position: relative;
          z-index: 1;
          opacity: 0;
          animation: fadeUp 0.8s cubic-bezier(0.22,1,0.36,1) 0.25s forwards;
        }


        .login-tagline {
          font-family: 'Cormorant Garamond', Georgia, serif;
          font-size: 56px;
          font-weight: 300;
          font-style: italic;
          line-height: 1.15;
          color: #fff;
          letter-spacing: -0.02em;
          margin-bottom: 28px;
          text-shadow: 0 2px 40px rgba(0,0,0,0.18);
        }

        .login-tagline em {
          font-style: normal;
          color: #5bbfb5;
          text-shadow: 0 0 40px rgba(91,191,181,0.4);
        }

        .login-desc {
          font-size: 14.5px;
          font-weight: 300;
          color: rgba(255,255,255,0.62);
          line-height: 1.75;
          max-width: 300px;
        }

        .login-left-footer {
          position: relative;
          z-index: 1;
          font-size: 11.5px;
          color: rgba(255,255,255,0.28);
          letter-spacing: 0.08em;
          text-transform: uppercase;
          opacity: 0;
          animation: fadeUp 0.7s cubic-bezier(0.22,1,0.36,1) 0.4s forwards;
        }

        /* ── Right panel ── */
        .login-right {
          background: #fff;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 60px 72px;
          position: relative;
        }

        .login-right::before {
          content: '';
          position: absolute;
          top: 0;
          bottom: 0;
          left: 0;
          width: 1px;
          background: linear-gradient(to bottom, transparent, rgba(7,59,44,0.1) 30%, rgba(7,59,44,0.1) 70%, transparent);
        }

        .login-form-wrap {
          width: 100%;
          max-width: 360px;
          opacity: 0;
          animation: fadeUp 0.8s cubic-bezier(0.22,1,0.36,1) 0.35s forwards;
        }

        .login-form-eyebrow {
          font-size: 11px;
          font-weight: 500;
          letter-spacing: 0.16em;
          text-transform: uppercase;
          color: #5bbfb5;
          margin-bottom: 14px;
        }

        .login-form-title {
          font-family: 'Cormorant Garamond', Georgia, serif;
          font-size: 48px;
          font-weight: 400;
          color: #073B2C;
          margin-bottom: 8px;
          line-height: 1.0;
          letter-spacing: -0.02em;
        }

        .login-form-sub {
          font-size: 14px;
          color: #8aaa9e;
          margin-bottom: 40px;
          font-weight: 300;
        }

        .login-divider {
          width: 36px;
          height: 1.5px;
          background: #5bbfb5;
          margin-bottom: 40px;
          border-radius: 2px;
        }

        /* ── Animations ── */
        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(16px); }
          to   { opacity: 1; transform: translateY(0); }
        }

        /* ── Responsive ── */
        @media (max-width: 720px) {
          .login-shell { grid-template-columns: 1fr; }
          .login-left { display: none; }
          .login-right { padding: 40px 24px; }
        }
      `}</style>

      <div className="login-shell">
        {/* Left — brand panel */}
        <LoginLeftPanel />

        {/* Right — form panel */}
        <div className="login-right">
          <div className="login-form-wrap">
            <div className="login-form-eyebrow">Välkommen tillbaka</div>
            <h1 className="login-form-title">Logga in</h1>
            <p className="login-form-sub">SMS‑påminnelsesystem</p>
            <div className="login-divider" />
            <LoginForm next={next} />
          </div>
        </div>
      </div>
    </>
  );
}
