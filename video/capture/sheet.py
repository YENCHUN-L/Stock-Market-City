import sys, glob, os
from PIL import Image
d, out = sys.argv[1], sys.argv[2]
fs = sorted(glob.glob(os.path.join(d, '*.jpg')))
step = max(1, len(fs) // 12); fs = fs[::step][:12]
S = Image.new('RGB', (4 * 480, 3 * 270))
for k, f in enumerate(fs): S.paste(Image.open(f).resize((480, 270)), ((k % 4) * 480, (k // 4) * 270))
S.save(out, quality=82)
print(len(fs), [os.path.basename(f) for f in fs])
