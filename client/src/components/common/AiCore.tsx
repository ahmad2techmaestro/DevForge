import { useEffect, useRef } from 'react';

interface Props {
  /** 0 = idle, 1+ = agents working. Drives rotation speed, pulse and glow. */
  energy: number;
  size?: number;
}

const N = 120;
const pts = Array.from({ length: N }, (_, i) => {
  const y = 1 - (i / (N - 1)) * 2;
  const r = Math.sqrt(1 - y * y);
  const th = Math.PI * (3 - Math.sqrt(5)) * i;
  return [Math.cos(th) * r, y, Math.sin(th) * r] as const;
});

function accentRgb(): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  return v ? v.split(/\s+/).join(',') : '110,150,255';
}

/** A rotating point-cloud "brain" drawn on canvas. Speeds up and glows while agents are working. */
export function AiCore({ energy, size = 280 }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const energyRef = useRef(energy);
  energyRef.current = energy;

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let angle = 0;
    let last = performance.now();
    let smooth = 0;
    let color = accentRgb();
    const mo = new MutationObserver(() => { color = accentRgb(); });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });

    const draw = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      smooth += (Math.min(energyRef.current, 4) - smooth) * Math.min(1, dt * 2.5);
      angle += dt * (0.18 + smooth * 0.45);
      const pulse = 1 + Math.sin(now / (900 - smooth * 120)) * (0.02 + smooth * 0.02);
      const R = size * 0.36 * pulse;
      const cx = size / 2, cy = size / 2;
      ctx.clearRect(0, 0, size, size);

      const glow = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 1.5);
      glow.addColorStop(0, `rgba(${color},${0.16 + smooth * 0.08})`);
      glow.addColorStop(1, `rgba(${color},0)`);
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, size, size);

      const ca = Math.cos(angle), sa = Math.sin(angle), tilt = 0.35, ct = Math.cos(tilt), st = Math.sin(tilt);
      const proj = pts.map(([x, y, z]) => {
        const x1 = x * ca + z * sa, z1 = -x * sa + z * ca;
        const y2 = y * ct - z1 * st, z2 = y * st + z1 * ct;
        return { x: cx + x1 * R, y: cy + y2 * R, d: (z2 + 1) / 2 };
      });
      ctx.lineWidth = 0.6;
      const reach = (R * 0.42) ** 2;
      for (let i = 0; i < N; i++) {
        for (let j = i + 1; j < N; j++) {
          const dx = proj[i].x - proj[j].x, dy = proj[i].y - proj[j].y;
          const d2 = dx * dx + dy * dy;
          if (d2 < reach) {
            const a = (1 - d2 / reach) * 0.35 * ((proj[i].d + proj[j].d) / 2 + 0.2);
            ctx.strokeStyle = `rgba(${color},${a})`;
            ctx.beginPath(); ctx.moveTo(proj[i].x, proj[i].y); ctx.lineTo(proj[j].x, proj[j].y); ctx.stroke();
          }
        }
      }
      for (let i = 0; i < N; i++) {
        const p = proj[i];
        const fire = smooth > 0.1 && Math.sin(now / 260 + i * 12.9898) > 0.93 - smooth * 0.03;
        ctx.fillStyle = fire ? 'rgba(255,255,255,0.95)' : `rgba(${color},${0.25 + p.d * 0.7})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, (fire ? 2.6 : 1.1) + p.d * 1.3, 0, Math.PI * 2); ctx.fill();
      }
      if (!still && !document.hidden) raf = requestAnimationFrame(draw);
      else if (!still) raf = window.setTimeout(() => { last = performance.now(); raf = requestAnimationFrame(draw); }, 500);
    };
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); clearTimeout(raf); mo.disconnect(); };
  }, [size]);

  return <canvas ref={ref} style={{ width: size, height: size }} aria-hidden role="presentation" />;
}
