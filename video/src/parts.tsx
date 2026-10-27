import React from 'react';
import { AbsoluteFill, Img, staticFile, useCurrentFrame } from 'remotion';
import { C, EASE, FONT, ramp } from './look';

const pad = (i: number) => String(i).padStart(4, '0');

// A captured JPEG sequence from the live app (public/footage/<market>/<clip>/NNNN.jpg).
export const Footage: React.FC<{ market: string; clip: string; frames: number; offset?: number; style?: React.CSSProperties }> = ({
  market, clip, frames, offset = 0, style,
}) => {
  const frame = useCurrentFrame();
  const i = Math.max(0, Math.min(frames - 1, frame + offset));
  return <Img src={staticFile(`footage/${market}/${clip}/${pad(i)}.jpg`)} style={{ position: 'absolute', width: 1920, height: 1080, ...style }} />;
};

// blur-slide: y / blur / opacity on one shared progress per word (card: typography/blur-slide).
export type Word = { text: string; start: number; dur?: number; color?: string };
export const Words: React.FC<{ words: Word[]; dy: number; blur: number; gap: string; style: React.CSSProperties; out?: number }> = ({
  words, dy, blur, gap, style, out = 0,
}) => {
  const frame = useCurrentFrame();
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap, whiteSpace: 'nowrap', opacity: 1 - out, ...style }}>
      {words.map((w, i) => {
        const p = ramp(frame, w.start, w.dur ?? 22, EASE.out);
        return (
          <span key={i} style={{
            display: 'inline-block', opacity: p, color: w.color,
            transform: `translateY(${((1 - p) * dy).toFixed(2)}px)`,
            filter: p >= 0.999 ? undefined : `blur(${((1 - p) * blur).toFixed(2)}px)`,
          }}>{w.text}</span>
        );
      })}
    </div>
  );
};

// Split copy into blur-slide units: words for Latin text, short phrases (2–3 chars) for Chinese.
export const units = (text: string, zh: boolean) => {
  if (!zh) return text.split(' ');
  const out: string[] = []; let buf = '';
  for (const ch of text) { buf += ch; if (/[，。？、·＋｜ ]/.test(ch) || buf.length >= 3) { out.push(buf); buf = ''; } }
  if (buf) out.push(buf);
  return out;
};
export const wordsFrom = (text: string, zh: boolean, start: number, gap: number, dur = 22, color?: string): Word[] =>
  units(text, zh).map((t, i) => ({ text: t, start: start + i * gap, dur, color }));

// Lower-third narration caption in the app's panel style. ≥56px so it reads on a phone (aesthetic-rules Q11).
// `left` pins the caption's left edge (clear of the app's legend panel on UI shots); otherwise it is centred.
export const Caption: React.FC<{ text: string; zh: boolean; start: number; end: number; accent?: string; sub?: string; y?: number; left?: number }> = ({
  text, zh, start, end, accent = C.acc, sub, y = 930, left,
}) => {
  const frame = useCurrentFrame();
  const p = ramp(frame, start, 18, EASE.enter), q = ramp(frame, end - 10, 10, EASE.exit);
  if (frame < start || frame > end) return null;
  return (
    <div style={{
      position: 'absolute', left: left ?? '50%', top: y, transform: `translate(${left === undefined ? '-50%' : '0'}, -100%) translateY(${((1 - p) * 24).toFixed(1)}px)`,
      opacity: p * (1 - q), display: 'flex', flexDirection: 'column', alignItems: left === undefined ? 'center' : 'flex-start', gap: 10,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 22, padding: '18px 34px', background: C.panel, border: `1px solid ${C.line}`,
        borderRadius: 14, boxShadow: '0 18px 50px rgba(0,0,0,0.55)', whiteSpace: 'nowrap',
      }}>
        <span style={{ width: 8, alignSelf: 'stretch', borderRadius: 4, background: accent }} />
        <Words words={wordsFrom(text, zh, start + 2, zh ? 3 : 2.5, 18)} dy={18} blur={8} gap={zh ? '0' : '0.28em'}
          style={{ fontFamily: zh ? FONT.zh : FONT.sans, fontSize: 56, fontWeight: 600, color: C.fg, letterSpacing: zh ? '0.02em' : '-0.01em' }} />
      </div>
      {sub && (
        <div style={{ fontFamily: zh ? FONT.zh : FONT.sans, fontSize: 34, color: C.mut, opacity: ramp(frame, start + 10, 18), whiteSpace: 'nowrap' }}>{sub}</div>
      )}
    </div>
  );
};

// Annotation pinned to a point in the 3D city (screen position re-projected every frame by the capture).
export const Callout: React.FC<{
  at?: [number, number, number]; head: string; body: string; start: number; end: number; color: string; zh: boolean;
  dx?: number; dy?: number; align?: 'left' | 'right';
}> = ({ at, head, body, start, end, color, zh, dx = 90, dy = -150, align = 'left' }) => {
  const frame = useCurrentFrame();
  if (!at || frame < start || frame > end) return null;
  const [x, y] = at;
  const dot = ramp(frame, start, 10, EASE.out);
  const line = ramp(frame, start + 4, 12, EASE.out);
  const box = ramp(frame, start + 10, 18, EASE.out);
  const fade = 1 - ramp(frame, end - 10, 10, EASE.exit);
  const lx = x + dx * line, ly = y + dy * line;
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: fade }}>
      <svg width={1920} height={1080} style={{ position: 'absolute', inset: 0 }}>
        <circle cx={x} cy={y} r={16 * dot} fill="none" stroke={color} strokeWidth={3} opacity={0.9} />
        <circle cx={x} cy={y} r={6 * dot} fill={color} />
        <line x1={x} y1={y} x2={lx} y2={ly} stroke={color} strokeWidth={3} strokeLinecap="round" />
      </svg>
      <div style={{
        position: 'absolute', left: x + dx, top: y + dy, transform: `translate(${align === 'left' ? '0' : '-100%'}, -50%) translateY(${((1 - box) * 16).toFixed(1)}px)`,
        opacity: box, filter: box >= 0.999 ? undefined : `blur(${((1 - box) * 8).toFixed(1)}px)`,
        background: C.panel, border: `1px solid ${C.line}`, borderLeft: `6px solid ${color}`, borderRadius: 12,
        padding: '14px 24px 16px', boxShadow: '0 16px 44px rgba(0,0,0,0.6)', whiteSpace: 'nowrap',
        fontFamily: zh ? FONT.zh : FONT.sans,
      }}>
        <div style={{ fontSize: 44, fontWeight: 700, color, letterSpacing: '-0.01em' }}>{head}</div>
        <div style={{ fontSize: 36, fontWeight: 500, color: C.fg, marginTop: 2 }}>{body}</div>
      </div>
    </div>
  );
};

// Brief zoom-punch on the footage layer at one of the film's three biggest hits (R4: ≤3 per film).
export const usePunch = (cutFrame: number, amount = 0.035) => {
  const frame = useCurrentFrame();
  return 1 + amount * (1 - ramp(frame, cutFrame, 12, EASE.out)) * (frame >= cutFrame ? 1 : 0);
};

export const Fill: React.FC<{ color?: string; opacity: number }> = ({ color = C.bg, opacity }) => (
  <AbsoluteFill style={{ background: color, opacity }} />
);

// Product mark: three towers in the app's colors (down / flat / up), drawn as a tiny skyline.
export const Mark: React.FC<{ size: number; grow?: number }> = ({ size, grow = 1 }) => {
  const s = size / 100;
  const bars = [
    { x: 8, h: 46, c: C.down }, { x: 38, h: 30, c: '#3a404d' }, { x: 68, h: 84, c: C.up },
  ];
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" style={{ overflow: 'visible' }}>
      <rect x={0} y={0} width={100} height={100} rx={22} fill="#141924" stroke={C.line} strokeWidth={2 / s} />
      {bars.map((b, i) => {
        const h = b.h * Math.min(1, Math.max(0, grow * 1.6 - i * 0.3));
        return <rect key={i} x={b.x + 4} y={92 - h} width={20} height={h} rx={3} fill={b.c} />;
      })}
    </svg>
  );
};
