// Capture metadata (screen-space anchors per frame, panel text, figures), written by capture/shots.mjs.
import usOpen from '../public/footage/us/open.json';
import usHero from '../public/footage/us/hero.json';
import usPeriods from '../public/footage/us/periods.json';
import usFlow from '../public/footage/us/flow.json';
import usVal from '../public/footage/us/val.json';
import usInv from '../public/footage/us/inv.json';
import twOpen from '../public/footage/tw/open.json';
import twHero from '../public/footage/tw/hero.json';
import twPeriods from '../public/footage/tw/periods.json';
import twFlow from '../public/footage/tw/flow.json';
import twVal from '../public/footage/tw/val.json';
import twInv from '../public/footage/tw/inv.json';

type P = [number, number, number];
export type Meta = {
  open: { flagship: { sym: string; name: string; cap: number; ret: Record<string, number> }; frames: { roof: P }[] };
  hero: {
    flagship: { sym: string; name: string; cap: number; ret1y: number };
    tall?: { sym: string; name: string; ret: number; cap: number };
    red?: { sym: string; name: string; ret: number; cap: number };
    frames: Record<string, P>[];
  };
  periods: { steps: { p: string; beat: number; frame: number; summary: string }[] };
  flow: { top: { path: string; amount: string }[]; src: string; dst: string; frames: { src: P; dst: P }[] };
  val: { panel: string; count: string };
  inv: { panel: string; count: string };
};

export const META = {
  us: { open: usOpen, hero: usHero, periods: usPeriods, flow: usFlow, val: usVal, inv: usInv },
  tw: { open: twOpen, hero: twHero, periods: twPeriods, flow: twFlow, val: twVal, inv: twInv },
} as unknown as Record<'us' | 'tw', Meta>;
