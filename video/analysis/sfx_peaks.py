import sys, glob, os, numpy as np, librosa
for f in sorted(glob.glob(sys.argv[1] + '/*.mp3')):
    if 'bgm' in f: continue
    y, sr = librosa.load(f, sr=None, mono=True)
    env = np.abs(y); k = int(np.argmax(env))
    print(f"{os.path.basename(f):28s} dur={len(y)/sr:5.2f}s peak@{k/sr:5.3f}s ({k/sr*30:4.1f}f) peak={20*np.log10(env[k]+1e-9):6.1f}dB")
