import sys, os
from PIL import Image
m, out = sys.argv[1], sys.argv[2]
shots = ['open', 'hero', 'periods', 'flow', 'val', 'inv', 'outro']
S = Image.new('RGB', (4 * 480, len(shots) * 270))
for r, s in enumerate(shots):
    d = f'public/footage/{m}/{s}'; fs = sorted(os.listdir(d)); n = len(fs)
    for c, k in enumerate([0, n // 3, 2 * n // 3, n - 1]):
        S.paste(Image.open(os.path.join(d, fs[k])).resize((480, 270)), (c * 480, r * 270))
S.save(out, quality=80)
