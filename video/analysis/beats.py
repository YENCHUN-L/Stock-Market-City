import json, sys, numpy as np, librosa
from scipy.signal import butter, sosfilt
y, sr = librosa.load(sys.argv[1], sr=None, mono=True)
dur = len(y)/sr
_, beats = librosa.beat.beat_track(y=y, sr=sr, tightness=400, units="time")
i = np.arange(len(beats)); A = np.vstack([i, np.ones_like(i)]).T
(T, t0), *_ = np.linalg.lstsq(A, beats, rcond=None)
res = beats - (t0 + i*T)
print(f"dur={dur:.2f} BPM={60/T:.3f} t0={t0:.4f} T={T:.5f} resid_max={np.abs(res).max()*1000:.1f}ms")
yp = librosa.effects.hpss(y)[1]
def env(lo, hi):
    sos = butter(4, [lo, hi], btype="band", fs=sr, output="sos")
    e = librosa.onset.onset_strength(y=sosfilt(sos, yp), sr=sr); return e, librosa.times_like(e, sr=sr)
ke, kt = env(40, 160)
on = librosa.onset.onset_detect(onset_envelope=ke, sr=sr, units="time", backtrack=False)
# move t0 back to first beat >= 0
while t0 - T > -0.02: t0 -= T
out = {}
for mult in (0.5, 1, 2):
    TT = T/mult; n = int((dur - t0)/TT)
    grid = t0 + np.arange(n)*TT
    d = np.array([np.min(np.abs(on - g)) for g in grid])
    out[mult] = dict(match=float(np.mean(d < 0.03)), mean_ms=float(np.mean(d[d<0.03])*1000))
    print(mult, out[mult])
rms = librosa.feature.rms(y=y)[0]; rt = librosa.times_like(rms, sr=sr)
nb = int((dur - t0)/T)
beat_rms = [float(rms[np.argmin(np.abs(rt-(t0+k*T)))]) for k in range(nb)]
beat_kick = [float(ke[np.argmin(np.abs(kt-(t0+k*T)))]) for k in range(nb)]
for k in range(0, nb, 4):
    print(k, f"{t0+k*T:6.2f}s", " ".join(f"{beat_rms[j]:.2f}" for j in range(k, min(k+4, nb))), " kick:", " ".join(f"{beat_kick[j]:.1f}" for j in range(k, min(k+4, nb))))
json.dump(dict(bpm=60/T, t0=t0, T=T, dur=dur, beat_rms=beat_rms, beat_kick=beat_kick, grids=out, onsets=on.tolist()), open(sys.argv[2], "w"))
