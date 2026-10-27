import sys
from PIL import Image
out, files = sys.argv[1], sys.argv[2:]
cols = 2; rows = (len(files) + 1) // 2
S = Image.new('RGB', (cols * 960, rows * 540))
for k, f in enumerate(files): S.paste(Image.open(f).resize((960, 540)), ((k % cols) * 960, (k // cols) * 540))
S.save(out, quality=82)
