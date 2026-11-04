#!/usr/bin/env python3
"""Contact sheet of numbered JPEG frames: python3 tools/sheet.py <dir> <out.jpg> [every] [fps] [from] [to] [cols] [tile_w]"""
import os, sys
from PIL import Image, ImageDraw

d, out = sys.argv[1], sys.argv[2]
every = int(sys.argv[3]) if len(sys.argv) > 3 else 4
fps = float(sys.argv[4]) if len(sys.argv) > 4 else 4
a = int(sys.argv[5]) if len(sys.argv) > 5 else 0
b = int(sys.argv[6]) if len(sys.argv) > 6 else 10 ** 9
cols = int(sys.argv[7]) if len(sys.argv) > 7 else 5
tw = int(sys.argv[8]) if len(sys.argv) > 8 else 384
files = sorted(f for f in os.listdir(d) if f.endswith('.jpg') and f[:4].isdigit())
files = [f for f in files if a <= int(f[:4]) <= b][::every]
tiles = []
for f in files:
    im = Image.open(os.path.join(d, f)).convert('RGB')
    im = im.resize((tw, round(im.height * tw / im.width)))
    ImageDraw.Draw(im).text((6, 4), f'{int(f[:4]) / fps:.2f}s', fill=(255, 220, 120))
    tiles.append(im)
th = tiles[0].height
rows = (len(tiles) + cols - 1) // cols
sheet = Image.new('RGB', (cols * tw, rows * th))
for i, t in enumerate(tiles):
    sheet.paste(t, ((i % cols) * tw, (i // cols) * th))
sheet.save(out, quality=85)
print(out, len(tiles), 'tiles')
