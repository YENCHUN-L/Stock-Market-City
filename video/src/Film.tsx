import React from 'react';
import { AbsoluteFill, Audio, Img, Sequence, interpolate, staticFile, useCurrentFrame } from 'remotion';
import { C, EASE, FONT, ramp } from './look';
import { COPY, Market, localAmount, summaryReturn } from './copy';
import { META } from './meta';
import { SHOTS, ShotKey, TOTAL, beatF, localBeat } from './timeline';
import { Callout, Caption, Fill, Footage, Mark, Words, usePunch, wordsFrom } from './parts';
import { SFX } from './sfx';

export type FilmProps = { market: Market; bgm: boolean };

const HANDLE = 8;
const clipFrames = (k: ShotKey) => SHOTS[k].dur + HANDLE;
const at = <T,>(arr: T[], i: number) => arr[Math.max(0, Math.min(arr.length - 1, i))];

// ---------- S1 open: crane-rise from the flagship's roof to the whole city, then the title ----------
const Open: React.FC<{ m: Market }> = ({ m }) => {
  const f = useCurrentFrame();
  const T = COPY[m], meta = META[m].open, zh = m === 'tw';
  const fl = meta.flagship;
  const titleAt = 168;
  const scrim = ramp(f, titleAt - 16, 40, EASE.smooth);
  return (
    <AbsoluteFill>
      <Footage market={m} clip="open" frames={clipFrames('open')} />
      <Callout at={at(meta.frames, f).roof} head={zh ? fl.name : fl.sym} body={zh ? '市值第一' : 'The largest company'}
        start={14} end={84} color={C.up} zh={zh} dx={80} dy={-140} />
      <AbsoluteFill style={{ background: `radial-gradient(ellipse 70% 60% at 50% 46%, rgba(11,14,20,${(0.78 * scrim).toFixed(3)}), rgba(11,14,20,${(0.35 * scrim).toFixed(3)}) 75%)` }} />
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 14, fontFamily: zh ? FONT.zh : FONT.sans }}>
        <Words words={wordsFrom(T.eyebrow, false, titleAt, 3, 18, C.teal)} dy={14} blur={6} gap="0.4em"
          style={{ fontSize: 36, fontWeight: 700, letterSpacing: '0.18em' }} />
        <Words words={T.title.map((t, i) => ({ text: t, start: titleAt + 6 + i * 6, dur: i ? 30 : 22, color: i ? C.up : C.fg }))} dy={56} blur={18} gap="0.3em"
          style={{ fontFamily: FONT.sans, fontSize: 150, fontWeight: 800, letterSpacing: '-0.035em', lineHeight: 1.05 }} />
        <Words words={wordsFrom(T.subtitle, zh, titleAt + 26, zh ? 4 : 3, 20)} dy={22} blur={9} gap={zh ? '0' : '0.26em'}
          style={{ fontSize: 56, fontWeight: 500, color: C.fg, marginTop: 8 }} />
      </AbsoluteFill>
      <Fill color="#000" opacity={1 - ramp(f, 0, 26, EASE.smooth)} />
    </AbsoluteFill>
  );
};

// ---------- S2 hero: the encoding, annotated in the city's own 3D space ----------
const Hero: React.FC<{ m: Market }> = ({ m }) => {
  const f = useCurrentFrame();
  const T = COPY[m], meta = META[m].hero, zh = m === 'tw';
  const fr = at(meta.frames, f);
  const s = usePunch(0);
  const end = SHOTS.hero.dur;
  const fp = T.footprint({ ...meta.flagship, ret: meta.flagship.ret1y });
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ transform: `scale(${s})` }}><Footage market={m} clip="hero" frames={clipFrames('hero')} /></AbsoluteFill>
      <Callout at={fr.flag} {...fp} start={localBeat('hero', 1)} end={end} color={C.acc} zh={zh} dx={110} dy={120} />
      {meta.tall && <Callout at={fr.tall} {...T.height(meta.tall)} start={localBeat('hero', 3)} end={end} color={C.up} zh={zh} dx={70} dy={-130} />}
      {meta.red && <Callout at={fr.red} {...T.color(meta.red)} start={localBeat('hero', 5)} end={end} color={C.down} zh={zh} dx={-40} dy={130} align="right" />}
      <Caption text={T.heroCaption} zh={zh} start={4} end={end + 4} y={1010} />
    </AbsoluteFill>
  );
};

// ---------- S3 periods: one period per two beats on the real header; the city re-ranks ----------
const Periods: React.FC<{ m: Market }> = ({ m }) => {
  const f = useCurrentFrame();
  const T = COPY[m], steps = META[m].periods.steps, zh = m === 'tw';
  const k = steps.reduce((acc, s, i) => (f >= s.frame ? i : acc), 0);
  const cur = steps[k];
  const ret = summaryReturn(cur.summary);
  const p = ramp(f, cur.frame, 12, EASE.out);
  return (
    <AbsoluteFill>
      <Footage market={m} clip="periods" frames={clipFrames('periods')} />
      <div style={{ position: 'absolute', right: 70, top: 150, textAlign: 'right', fontFamily: zh ? FONT.zh : FONT.sans }}>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginBottom: 14 }}>
          {steps.map((s, i) => (
            <span key={s.p} style={{ width: 40, height: 8, borderRadius: 4, background: i <= k ? C.acc : C.line }} />
          ))}
        </div>
        <div style={{ fontSize: 48, fontWeight: 700, color: C.mut, letterSpacing: zh ? '0.05em' : '0.12em',
          opacity: p, transform: `translateY(${(1 - p) * 14}px)`, filter: p > 0.999 ? undefined : `blur(${(1 - p) * 6}px)` }}>
          {T.periodName[cur.p]}
        </div>
        <div style={{ fontFamily: FONT.sans, fontSize: 132, fontWeight: 800, letterSpacing: '-0.03em', lineHeight: 1.05,
          color: ret.startsWith('+') ? C.up : C.down, opacity: p, transform: `translateY(${(1 - p) * 26}px)`,
          filter: p > 0.999 ? undefined : `blur(${(1 - p) * 12}px)` }}>
          {ret}
        </div>
        <div style={{ fontSize: 34, color: C.fg, opacity: 0.85 * p }}>{zh ? '台股 上市＋上櫃（市值加權）' : 'S&P 1500, cap-weighted'}</div>
      </div>
      <Caption text={T.periodCaption} zh={zh} start={6} end={SHOTS.periods.dur + 4} left={470} />
    </AbsoluteFill>
  );
};

// ---------- breathing title card over a defocused frame of the previous shot ----------
const Card: React.FC<{ m: Market; lines: string[]; accent: number; color: string; bgClip: string; bgFrame: number }> = ({
  m, lines, accent, color, bgClip, bgFrame,
}) => {
  const f = useCurrentFrame();
  const zh = m === 'tw';
  const push = 1 + 0.03 * ramp(f, 0, SHOTS.card1.dur, EASE.smooth);
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <Img src={staticFile(`footage/${m}/${bgClip}/${String(bgFrame).padStart(4, '0')}.jpg`)}
        style={{ position: 'absolute', width: 1920, height: 1080, filter: 'blur(22px) saturate(0.8)', transform: 'scale(1.08)', opacity: 0.55 }} />
      <Fill opacity={0.55} />
      <AbsoluteFill style={{ justifyContent: 'center', paddingLeft: 200, transform: `scale(${push})`, transformOrigin: '200px 540px' }}>
        <div style={{ width: 120 * ramp(f, 2, 18, EASE.out), height: 8, borderRadius: 4, background: color, marginBottom: 34 }} />
        {lines.map((l, i) => (
          <Words key={i} words={wordsFrom(l, zh, 4 + i * 9, zh ? 4 : 4, 22, i === accent ? color : C.fg)} dy={56} blur={18} gap={zh ? '0' : '0.26em'}
            style={{ fontFamily: zh ? FONT.zh : FONT.sans, fontSize: 132, fontWeight: 800, letterSpacing: zh ? '0.02em' : '-0.03em', lineHeight: 1.12 }} />
        ))}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// ---------- S5 flow: the biggest rotation, pinned to its two districts ----------
const Flow: React.FC<{ m: Market }> = ({ m }) => {
  const f = useCurrentFrame();
  const T = COPY[m], meta = META[m].flow, zh = m === 'tw';
  const fr = at(meta.frames, f);
  const top = meta.top[0];
  const p = ramp(f, localBeat('flow', 2), 20, EASE.out);
  const end = SHOTS.flow.dur;
  return (
    <AbsoluteFill>
      <Footage market={m} clip="flow" frames={clipFrames('flow')} />
      <Callout at={fr.src} head={meta.src} body={zh ? '資金流出' : 'Value out'} start={localBeat('flow', 1)} end={end} color={C.down} zh={zh} dx={-60} dy={-120} align="right" />
      <Callout at={fr.dst} head={meta.dst} body={zh ? '資金流入' : 'Value in'} start={localBeat('flow', 1.5)} end={end} color={C.up} zh={zh} dx={70} dy={110} />
      <div style={{ position: 'absolute', left: 0, right: 0, top: 70, display: 'flex', flexDirection: 'column', alignItems: 'center',
        opacity: p, transform: `translateY(${(1 - p) * 24}px)`, filter: p > 0.999 ? undefined : `blur(${(1 - p) * 10}px)`, fontFamily: zh ? FONT.zh : FONT.sans }}>
        <div style={{ fontSize: 40, fontWeight: 600, color: C.mut, letterSpacing: zh ? '0.06em' : '0.02em' }}>{zh ? '最大資金流' : 'Biggest flow'} · {T.flowSub}</div>
        <div style={{ fontFamily: FONT.sans, fontSize: 120, fontWeight: 800, color: C.teal, letterSpacing: '-0.03em', lineHeight: 1.1 }}>{localAmount(m, top.amount)}</div>
      </div>
      <Caption text={T.flowCaption} zh={zh} start={localBeat('flow', 4)} end={end + 4} accent={C.teal} y={1050} />
    </AbsoluteFill>
  );
};

// ---------- S7/S8 highlight views on the real UI ----------
const Highlight: React.FC<{ m: Market; slot: 'feat1' | 'feat2' }> = ({ m, slot }) => {
  const f = useCurrentFrame();
  const T = COPY[m], zh = m === 'tw';
  const kind = (m === 'us') === (slot === 'feat1') ? 'val' : 'inv';
  const meta = META[m][kind];
  const s = usePunch(slot === 'feat1' ? 0 : -999);
  const color = kind === 'val' ? C.gold : C.cyan;
  const n = +(meta.count.match(/\d[\d,]*/)?.[0].replace(/,/g, '') ?? 0);
  const p = ramp(f, 8, 20, EASE.out);
  const roll = Math.round(n * ramp(f, 8, 30, EASE.out));
  const lines = meta.panel.split('\n').map(x => x.trim()).filter(Boolean);
  let eyebrow = '', big = '', label = '';
  if (kind === 'val') {
    eyebrow = zh ? '★ 高度低估' : '★ UNDERVALUED';
    big = String(roll); label = zh ? '家公司' : 'highly undervalued';
  } else if (m === 'us') {
    eyebrow = 'FAMOUS INVESTORS · 13F';
    big = String(roll); label = 'stocks they hold';
  } else {
    const i = lines.findIndex(x => /Top buys/.test(x));
    const [code, name, amt] = [lines[i + 2], lines[i + 3], lines[i + 4]];
    eyebrow = '三大法人 · 近 60 日買超第一';
    big = localAmount(m, amt ?? ''); label = name ? `${name}（${code}）` : '';
  }
  const caption = slot === 'feat1' ? T.feat1Caption : T.feat2Caption;
  const sub = slot === 'feat2' && m === 'us' ? T.feat2Sub : undefined;
  const end = SHOTS[slot].dur;
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ transform: `scale(${s})` }}><Footage market={m} clip={kind} frames={clipFrames(slot)} /></AbsoluteFill>
      <div style={{ position: 'absolute', left: 470, top: 140, fontFamily: zh ? FONT.zh : FONT.sans, opacity: p,
        transform: `translateY(${(1 - p) * 20}px)`, filter: p > 0.999 ? undefined : `blur(${(1 - p) * 10}px)`,
        padding: '20px 32px 24px', background: 'rgba(11,14,20,0.72)', borderRadius: 16, borderLeft: `6px solid ${color}` }}>
        <div style={{ fontSize: 38, fontWeight: 700, color, letterSpacing: zh ? '0.06em' : '0.14em' }}>{eyebrow}</div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 20 }}>
          <span style={{ fontFamily: FONT.sans, fontSize: 116, fontWeight: 800, color: C.fg, letterSpacing: '-0.03em', lineHeight: 1.08 }}>{big}</span>
          <span style={{ fontSize: 44, fontWeight: 600, color: C.fg }}>{label}</span>
        </div>
      </div>
      <Caption text={caption} zh={zh} start={localBeat(slot, 1)} end={end + 4} accent={color} sub={sub} y={sub ? 960 : 1010} left={470} />
    </AbsoluteFill>
  );
};

// ---------- S9 outro: the flat map from above, lockup ----------
const Outro: React.FC<{ m: Market }> = ({ m }) => {
  const f = useCurrentFrame();
  const T = COPY[m], zh = m === 'tw';
  const s = usePunch(0);
  const dim = ramp(f, 4, 26, EASE.smooth);
  const L = localBeat('outro', 1);
  const mark = ramp(f, L, 22, EASE.out);
  const total = TOTAL - SHOTS.outro.from;
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ transform: `scale(${s})` }}>
        <Footage market={m} clip="outro" frames={clipFrames('outro') + 30} />
      </AbsoluteFill>
      <AbsoluteFill style={{ background: `radial-gradient(ellipse 60% 55% at 50% 48%, rgba(11,14,20,${0.86 * dim}), rgba(11,14,20,${0.6 * dim}))` }} />
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column', fontFamily: zh ? FONT.zh : FONT.sans }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 40 }}>
          <div style={{ opacity: mark, transform: `scale(${0.6 + 0.4 * mark})`, filter: mark > 0.999 ? undefined : `blur(${(1 - mark) * 10}px)` }}>
            <Mark size={150} grow={ramp(f, L + 4, 26, EASE.out)} />
          </div>
          <div>
            <Words words={T.outroTitle.map((t, i) => ({ text: t, start: L + 8 + i * 6, dur: 24, color: i ? C.up : C.fg }))} dy={40} blur={14} gap="0.28em"
              style={{ fontFamily: FONT.sans, fontSize: 112, fontWeight: 800, letterSpacing: '-0.035em', lineHeight: 1.05 }} />
            <Words words={wordsFrom(T.outroTag, zh, L + 22, zh ? 4 : 3, 20)} dy={18} blur={8} gap={zh ? '0' : '0.26em'}
              style={{ fontSize: 50, fontWeight: 500, color: C.fg, marginTop: 10 }} />
          </div>
        </div>
        <div style={{ marginTop: 64, fontFamily: '"Noto Sans Mono", monospace', fontSize: 38, color: C.teal, opacity: ramp(f, L + 34, 18),
          padding: '12px 28px', border: `1px solid ${C.line}`, borderRadius: 10, background: C.panel }}>
          {T.outroRun}
        </div>
      </AbsoluteFill>
      <div style={{ position: 'absolute', bottom: 34, left: 0, right: 0, textAlign: 'center', fontFamily: zh ? FONT.zh : FONT.sans,
        fontSize: 30, color: C.mut, opacity: ramp(f, L + 40, 18) }}>{T.disclaimer}</div>
      <Fill color="#000" opacity={ramp(f, total - 22, 22, EASE.smooth)} />
    </AbsoluteFill>
  );
};

export const Film: React.FC<FilmProps> = ({ market: m, bgm }) => {
  const frame = useCurrentFrame();
  const T = COPY[m];
  const seq = (k: ShotKey, el: React.ReactNode, extra = 0) => (
    <Sequence key={k} from={SHOTS[k].from} durationInFrames={SHOTS[k].dur + extra}>{el}</Sequence>
  );
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      {seq('open', <Open m={m} />)}
      {seq('hero', <Hero m={m} />)}
      {seq('periods', <Periods m={m} />)}
      {seq('card1', <Card m={m} lines={T.card1} accent={T.card1Accent} color={C.teal} bgClip="periods" bgFrame={SHOTS.periods.dur - 1} />)}
      {seq('flow', <Flow m={m} />)}
      {seq('card2', <Card m={m} lines={T.card2} accent={T.card2Accent} color={m === 'us' ? C.gold : C.cyan} bgClip="flow" bgFrame={SHOTS.flow.dur - 1} />)}
      {seq('feat1', <Highlight m={m} slot="feat1" />)}
      {seq('feat2', <Highlight m={m} slot="feat2" />)}
      {seq('outro', <Outro m={m} />, TOTAL - SHOTS.outro.to)}
      {bgm && (
        <Audio src={staticFile('audio/bgm-tech-house.mp3')}
          volume={interpolate(frame, [0, 12, TOTAL - 50, TOTAL], [0, 0.34, 0.34, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })} />
      )}
      {SFX(m).map((s, i) => (
        <Sequence key={i} from={s.from} durationInFrames={s.dur}>
          <Audio src={staticFile(`audio/${s.src}`)} volume={s.volume} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

export const FILM_DURATION = TOTAL;
export { beatF };
