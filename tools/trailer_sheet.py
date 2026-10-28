#!/usr/bin/env python3
"""Contact sheet of captured PV shots: python3 tools/trailer_sheet.py <framesDir> <out.jpg> shot[,shot...] [per=6]"""
import os, sys
from PIL import Image
d, out, shots = sys.argv[1], sys.argv[2], sys.argv[3].split(',')
per = int(sys.argv[4]) if len(sys.argv) > 4 else 6
tw, th = 320, 180
rows = []
for s in shots:
    fs = sorted(f for f in os.listdir(f'{d}/{s}') if f.endswith('.jpg'))
    idx = [round(i * (len(fs) - 1) / (per - 1)) for i in range(per)]
    rows.append([Image.open(f'{d}/{s}/{fs[i]}').resize((tw, th)) for i in idx])
sheet = Image.new('RGB', (tw * per, th * len(rows)))
for r, row in enumerate(rows):
    for c, im in enumerate(row):
        sheet.paste(im, (c * tw, r * th))
sheet.save(out, quality=85)
print(out)
