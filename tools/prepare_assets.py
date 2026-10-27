"""Copy pack assets into public/assets and build web-optimised caretaker GLBs.

Usage: python3 -I tools/prepare_assets.py <path-to-parking3_complete> <project-root>
- Copies runtime GLBs (not the legacy proxy or the sample floor).
- Re-encodes the caretaker's embedded PNG base-colour textures as JPEG (q=86),
  keeping resolution, nodes, morphs and clips unchanged.
- Copies the 16 WAV files and the UI parts used by the HUD.
"""
import io, json, os, shutil, struct, sys
from PIL import Image

src, root = sys.argv[1], sys.argv[2]
A = os.path.join(src, 'parking3_3d_audio')
C = os.path.join(src, 'parking3_claude')
out = os.path.join(root, 'public', 'assets')

models = ['floor_shell', 'elevator_animated', 'bicycle_city_basket', 'bicycle_city_plain',
          'bicycle_sport_plain', 'bicycle_folding_basket', 'bicycle_folding_plain',
          'bicycle_rack', 'payment_terminal', 'bedroom', 'outdoor_exit']
for m in models:
    shutil.copy(os.path.join(A, 'models', m + '.glb'), os.path.join(out, 'models', m + '.glb'))

def read_glb(p):
    d = open(p, 'rb').read()
    l0, _ = struct.unpack('<II', d[12:20])
    j = json.loads(d[20:20 + l0])
    o = 20 + l0
    l1, _ = struct.unpack('<II', d[o:o + 8])
    return j, d[o + 8:o + 8 + l1]

def write_glb(p, j, binbuf):
    js = json.dumps(j, separators=(',', ':')).encode()
    js += b' ' * ((4 - len(js) % 4) % 4)
    binbuf += b'\0' * ((4 - len(binbuf) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(binbuf)
    with open(p, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, total))
        f.write(struct.pack('<II', len(js), 0x4E4F534A)); f.write(js)
        f.write(struct.pack('<II', len(binbuf), 0x004E4942)); f.write(binbuf)

def jpeg_textures(srcp, dstp):
    j, b = read_glb(srcp)
    img_views = {im['bufferView']: i for i, im in enumerate(j.get('images', []))}
    new = bytearray(); views = []
    for vi, bv in enumerate(j['bufferViews']):
        data = b[bv.get('byteOffset', 0): bv.get('byteOffset', 0) + bv['byteLength']]
        if vi in img_views:
            im = Image.open(io.BytesIO(data)).convert('RGB')
            buf = io.BytesIO(); im.save(buf, 'JPEG', quality=86, optimize=True, progressive=False)
            data = buf.getvalue()
            j['images'][img_views[vi]]['mimeType'] = 'image/jpeg'
        while len(new) % 4: new.append(0)
        nbv = dict(bv); nbv['byteOffset'] = len(new); nbv['byteLength'] = len(data)
        new += data; views.append(nbv)
    j['bufferViews'] = views
    j['buffers'] = [{'byteLength': len(new)}]
    write_glb(dstp, j, bytes(new))
    print(os.path.basename(dstp), os.path.getsize(srcp), '->', os.path.getsize(dstp))

jpeg_textures(os.path.join(A, 'caretaker_v2/models/caretaker_expression_v2_lod.glb'), os.path.join(out, 'models', 'caretaker_lod.glb'))
jpeg_textures(os.path.join(A, 'caretaker_v2/models/caretaker_expression_v2.glb'), os.path.join(out, 'models', 'caretaker_hi.glb'))

for f in os.listdir(os.path.join(A, 'audio')):
    shutil.copy(os.path.join(A, 'audio', f), os.path.join(out, 'audio', f))
shutil.copy(os.path.join(A, 'data', 'audio_manifest.json'), os.path.join(out, 'audio', 'audio_manifest.json'))

ui = ['ui/title_lockup.svg', 'ui/secret_ending_caption.svg', 'signage/operating_rules.png',
      'props/paid_receipt.png', 'props/bicycle_city.svg', 'props/bicycle_sport.svg', 'props/bicycle_folding.svg',
      'props/color_tag_red.svg', 'props/color_tag_blue.svg', 'props/color_tag_cream.svg',
      'signage/floor_1.png', 'signage/floor_2.png', 'signage/floor_3.png', 'signage/floor_4.png', 'signage/floor_5.png']
for name in ['key', 'receipt', 'light', 'note', 'bike', 'warning', 'pause', 'close', 'arrow_up', 'arrow_down',
             'arrow_left', 'arrow_right', 'bag', 'eye', 'rail', 'sound', 'check', 'bell']:
    ui.append('icons/' + name + '.svg')
for u in ui:
    shutil.copy(os.path.join(C, 'assets', u), os.path.join(out, 'ui', os.path.basename(u)))
print('copied', len(models), 'models,', len(os.listdir(os.path.join(out, 'audio'))), 'audio files,', len(ui), 'ui parts')
