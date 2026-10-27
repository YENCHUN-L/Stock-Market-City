// Single source of truth for timing. Every shot boundary and SFX pin is a beat of the BGM grid
// (analysis/beat_data.json: 124.0 BPM, downbeats on multiples of 4 after re-indexing).
import TL from './timeline.json';

export const FPS = TL.fps;
export const SOURCE_BEAT0 = TL.sourceBeat0; // seconds, from the source-track analysis; never mix render offsets in here
export const BEAT_INT = TL.beatInt;         // seconds per beat
export const OUTPUT_AUDIO_OFFSET_SEC = 0.0424; // measured: Remotion 4.0.484 h264/AAC 48kHz mp4 audio lags 42.4ms (analysis/offset.py)
export const beatT = (n: number) => SOURCE_BEAT0 + OUTPUT_AUDIO_OFFSET_SEC + n * BEAT_INT;
export const beatF = (n: number) => Math.round(beatT(n) * FPS);
export const BEAT_FRAMES = BEAT_INT * FPS;

export type ShotKey = keyof typeof TL.shots;
export const SHOTS = Object.fromEntries(
  Object.entries(TL.shots).map(([k, [a, b]]) => {
    const from = a === 0 ? 0 : beatF(a);
    return [k, { from, to: beatF(b), dur: beatF(b) - from, beats: [a, b] as [number, number] }];
  }),
) as Record<ShotKey, { from: number; to: number; dur: number; beats: [number, number] }>;

// Local frame of beat n inside a shot.
export const localBeat = (shot: ShotKey, n: number) => beatF(SHOTS[shot].beats[0] + n) - SHOTS[shot].from;
export const SLAM_BEATS = TL.slamBeats;
export const TOTAL = SHOTS.outro.to + TL.tailFrames;
