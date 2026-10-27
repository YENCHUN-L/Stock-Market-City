// SFX pin table. Every `from` is relative to the beat grid / shot starts, and compensates the sample's own peak lag
// (measured by analysis/sfx_peaks.py) so the peak, not the file start, lands on the picture event.
import { Market } from './copy';
import { SHOTS, beatF, localBeat } from './timeline';

export type Sfx = { from: number; src: string; volume: number; dur: number; note: string };

// Peak lag of each sample, in frames @30fps.
const LAG: Record<string, number> = {
  'air-woosh-deep.mp3': 15, 'air-woosh-quick.mp3': 7, 'bass-hit-futuristic.mp3': 6, 'impact-cine-big.mp3': 65,
  'impact-deep-whoosh.mp3': 17, 'light-aura.mp3': 34, 'shimmer-sparkle-sweep.mp3': 29, 'sparkle.mp3': 44,
  'stardust-swish.mp3': 29, 'sweep-digital.mp3': 11, 'sweep-fast-small.mp3': 9, 'switch-click-quick.mp3': 0,
  'switch-tap.mp3': 0, 'whoosh-fast.mp3': 21,
};
const pin = (peakAt: number, src: string, volume: number, dur: number, note: string): Sfx =>
  ({ from: Math.max(0, peakAt - LAG[src]), src, volume, dur, note });

export const SFX = (m: Market): Sfx[] => {
  const abs = (k: keyof typeof SHOTS, local: number) => SHOTS[k].from + local;
  const valSlot = m === 'us' ? 'feat1' : 'feat2';
  const invSlot = m === 'us' ? 'feat2' : 'feat1';
  return [
    pin(68, 'air-woosh-deep.mp3', 0.45, 80, 'open: crane lifts off the flagship roof (speed peak ≈ 19% into the rise)'),
    pin(196, 'shimmer-sparkle-sweep.mp3', 0.28, 70, 'open: title word lands'),
    pin(beatF(16), 'impact-deep-whoosh.mp3', 0.6, 90, 'SLAM 1 (b16): cut to the hero row, zoom-punch'),
    pin(beatF(17) + 10, 'sweep-fast-small.mp3', 0.3, 24, 'hero: footprint callout box'),
    pin(beatF(19) + 10, 'sweep-fast-small.mp3', 0.26, 24, 'hero: height callout box'),
    pin(beatF(21) + 10, 'sweep-fast-small.mp3', 0.22, 24, 'hero: color callout box'),
    ...[0, 2, 4, 6, 8].map((b, i) =>
      pin(beatF(26 + b), i % 2 ? 'switch-tap.mp3' : 'switch-click-quick.mp3', 0.5 - i * 0.04, 20, `periods: header click #${i + 1}`)),
    pin(beatF(36) + 3, 'whoosh-fast.mp3', 0.35, 50, 'card1 in'),
    pin(beatF(40), 'air-woosh-quick.mp3', 0.35, 40, 'flow: cut in'),
    pin(beatF(42) + 6, 'stardust-swish.mp3', 0.3, 80, 'flow: biggest-flow figure lands'),
    pin(beatF(52) + 3, 'whoosh-fast.mp3', 0.32, 50, 'card2 in'),
    pin(beatF(56), 'bass-hit-futuristic.mp3', 0.6, 80, 'SLAM 2 (b56): feature reveal, zoom-punch'),
    pin(abs(valSlot, 4), 'switch-click-quick.mp3', 0.4, 20, '★ Undervalued button click'),
    pin(abs(valSlot, 20), 'light-aura.mp3', 0.32, 110, 'gold beams rise over undervalued companies'),
    pin(abs(invSlot, 4), 'switch-tap.mp3', 0.4, 20, 'investors / 三大法人 button click'),
    pin(abs(invSlot, 14), 'sweep-digital.mp3', 0.3, 34, 'holdings light up'),
    pin(beatF(66), 'air-woosh-quick.mp3', 0.32, 40, 'feat2: cut in'),
    pin(beatF(72), 'impact-cine-big.mp3', 0.55, 230, 'SLAM 3 (b72): outro; built-in 2s whoosh rises into the cut'),
    pin(SHOTS.outro.from + localBeat('outro', 1) + 38, 'sparkle.mp3', 0.5, 120, 'outro: wordmark settles'),
  ];
};
