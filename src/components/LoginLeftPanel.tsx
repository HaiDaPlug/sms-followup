"use client";

import { useEffect, useRef } from "react";

const PARTICLE_COUNT = 72;
const CONNECTION_DIST = 120;
const REPEL_DIST = 90;
const REPEL_FORCE = 0.28;
const BASE_SPEED = 0.35;
const MINT = { r: 91, g: 191, b: 181 };
const WHITE = { r: 255, g: 255, b: 255 };

type Particle = {
  x: number; y: number;
  vx: number; vy: number;
  size: number;
  color: typeof MINT | typeof WHITE;
};

export function LoginLeftPanel() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mouse = useRef({ x: -999, y: -999 });
  const particles = useRef<Particle[]>([]);
  const raf = useRef<number>(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d")!;

    function resize() {
      canvas!.width  = wrap!.offsetWidth;
      canvas!.height = wrap!.offsetHeight;
    }
    resize();
    window.addEventListener("resize", resize);

    // Init particles
    particles.current = Array.from({ length: PARTICLE_COUNT }, () => ({
      x: Math.random() * canvas!.width,
      y: Math.random() * canvas!.height,
      vx: (Math.random() - 0.5) * BASE_SPEED,
      vy: (Math.random() - 0.5) * BASE_SPEED,
      size: Math.random() * 1.4 + 0.6,
      color: Math.random() > 0.72 ? MINT : WHITE,
    }));

    function onMove(e: MouseEvent) {
      const rect = canvas!.getBoundingClientRect();
      mouse.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }
    function onLeave() { mouse.current = { x: -999, y: -999 }; }

    wrap.addEventListener("mousemove", onMove);
    wrap.addEventListener("mouseleave", onLeave);

    function draw() {
      const W = canvas!.width;
      const H = canvas!.height;
      ctx.clearRect(0, 0, W, H);

      const ps = particles.current;
      const mx = mouse.current.x;
      const my = mouse.current.y;

      // Update + repel
      for (const p of ps) {
        const dx = p.x - mx;
        const dy = p.y - my;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < REPEL_DIST && dist > 0) {
          const force = (REPEL_DIST - dist) / REPEL_DIST * REPEL_FORCE;
          p.vx += (dx / dist) * force;
          p.vy += (dy / dist) * force;
        }

        // Dampen
        p.vx *= 0.98;
        p.vy *= 0.98;

        // Maintain minimum speed
        const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
        if (speed < BASE_SPEED * 0.3) {
          p.vx += (Math.random() - 0.5) * 0.05;
          p.vy += (Math.random() - 0.5) * 0.05;
        }

        p.x += p.vx;
        p.y += p.vy;

        // Wrap edges
        if (p.x < 0) p.x = W;
        if (p.x > W) p.x = 0;
        if (p.y < 0) p.y = H;
        if (p.y > H) p.y = 0;
      }

      // Draw connections
      for (let i = 0; i < ps.length; i++) {
        for (let j = i + 1; j < ps.length; j++) {
          const dx = ps[i].x - ps[j].x;
          const dy = ps[i].y - ps[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > CONNECTION_DIST) continue;

          const alpha = (1 - dist / CONNECTION_DIST) * 0.18;
          const c = ps[i].color;
          ctx.beginPath();
          ctx.moveTo(ps[i].x, ps[i].y);
          ctx.lineTo(ps[j].x, ps[j].y);
          ctx.strokeStyle = `rgba(${c.r},${c.g},${c.b},${alpha})`;
          ctx.lineWidth = 0.6;
          ctx.stroke();
        }
      }

      // Draw dots
      for (const p of ps) {
        const dx = p.x - mx;
        const dy = p.y - my;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const proximity = Math.max(0, 1 - dist / 140);
        const alpha = 0.35 + proximity * 0.55;
        const size = p.size + proximity * 1.2;

        ctx.beginPath();
        ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${p.color.r},${p.color.g},${p.color.b},${alpha})`;
        ctx.fill();
      }

      raf.current = requestAnimationFrame(draw);
    }

    raf.current = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf.current);
      window.removeEventListener("resize", resize);
      wrap.removeEventListener("mousemove", onMove);
      wrap.removeEventListener("mouseleave", onLeave);
    };
  }, []);

  return (
    <div className="login-left" ref={wrapRef}>
      <div className="login-left-noise" />
      <div className="login-left-glow" />
      <div className="login-left-glow-2" />

      <canvas
        ref={canvasRef}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
          zIndex: 0,
        }}
      />

      <div className="login-logo">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/osteopaticentrum.svg" alt="Osteopaticentrum" />
      </div>

      <div className="login-left-body">
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
  );
}
