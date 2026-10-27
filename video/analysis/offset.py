import sys, numpy as np, librosa
src, _ = librosa.load(sys.argv[1], sr=8000, mono=True, duration=40)
ren, _ = librosa.load(sys.argv[2], sr=8000, mono=True, duration=40)
# Compare the stretch before the outro (only BGM + light SFX), 3s..30s
a = src[3*8000:30*8000]; best = None
for lag in range(-400, 401):  # ±50ms
    b = ren[3*8000+lag:30*8000+lag]
    c = np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9)
    if best is None or c > best[1]: best = (lag, c)
print(f"render audio lag = {best[0]/8000*1000:.1f} ms ({best[0]/8000*30:.2f} f), corr={best[1]:.3f}")
