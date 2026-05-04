import { LoginForm } from "@/components/LoginForm";

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
          height: 32px;
          filter: brightness(0) invert(1);
          opacity: 0.9;
        }

        .login-left-body {
          position: relative;
          z-index: 1;
          opacity: 0;
          animation: fadeUp 0.8s cubic-bezier(0.22,1,0.36,1) 0.25s forwards;
        }

        .login-spine {
          margin-bottom: 40px;
          opacity: 0.22;
        }

        .login-tagline {
          font-family: 'Cormorant Garamond', Georgia, serif;
          font-size: 42px;
          font-weight: 300;
          font-style: italic;
          line-height: 1.25;
          color: #fff;
          letter-spacing: -0.01em;
          margin-bottom: 24px;
        }

        .login-tagline em {
          font-style: normal;
          color: #5bbfb5;
        }

        .login-desc {
          font-size: 13.5px;
          font-weight: 300;
          color: rgba(255,255,255,0.5);
          line-height: 1.7;
          max-width: 280px;
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
          padding: 60px 48px;
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
          font-size: 10.5px;
          font-weight: 500;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          color: #5bbfb5;
          margin-bottom: 12px;
        }

        .login-form-title {
          font-family: 'Cormorant Garamond', Georgia, serif;
          font-size: 36px;
          font-weight: 400;
          color: #073B2C;
          margin-bottom: 6px;
          line-height: 1.1;
          letter-spacing: -0.02em;
        }

        .login-form-sub {
          font-size: 13px;
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
        <div className="login-left">
          <div className="login-left-noise" />
          <div className="login-left-glow" />
          <div className="login-left-glow-2" />

          <div className="login-logo">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/osteopaticentrum.svg" alt="Osteopaticentrum" />
          </div>

          <div className="login-left-body">
            {/* Stylised vertebrae motif */}
            <div className="login-spine">
              <svg width="48" height="120" viewBox="0 0 48 120" fill="none" xmlns="http://www.w3.org/2000/svg">
                {[0,1,2,3,4].map((i) => (
                  <g key={i} transform={`translate(0, ${i * 24})`}>
                    <rect x="14" y="3" width="20" height="14" rx="3" fill="white" />
                    <rect x="4" y="7" width="8" height="6" rx="2" fill="white" />
                    <rect x="36" y="7" width="8" height="6" rx="2" fill="white" />
                    <line x1="24" y1="17" x2="24" y2="27" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
                  </g>
                ))}
              </svg>
            </div>

            <p className="login-tagline">
              Rörelse är<br /><em>medicinens</em><br />ursprung.
            </p>
            <p className="login-desc">
              Patienthantering och automatiska SMS‑påminnelser för Osteopaticentrum Borås.
            </p>
          </div>

          <div className="login-left-footer">
            Osteopaticentrum · Borås · Sverige
          </div>
        </div>

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
