"""Cut the small font file the usage board draws with from Anthropic Sans, using the copy the Claude desktop app
already caches on THIS computer. The typeface belongs to Anthropic and is not part of this repository: nothing is
downloaded or redistributed, the file is made on your machine for your own use and stays out of git.

    python -I build_font.py <output.woff2> [path-to-an-Anthropic-Sans-woff2/ttf]

Needs the `fonttools` and `brotli` packages (pip install fonttools brotli). Exit codes: 0 written, 1 no font found,
2 packages missing."""
import glob
import io
import os
import struct
import sys

try:
    from fontTools import subset
    from fontTools.ttLib import TTFont, woff2
    from fontTools.varLib import instancer
    if not woff2.haveBrotli:
        raise ImportError('brotli')
except ImportError as err:
    print(f'build_font: missing package ({err}); run: pip install fonttools brotli', file=sys.stderr)
    sys.exit(2)

# Older fontTools cannot read the 'overlapSimpleBitmap' glyf option newer WOFF2 files use; drop that bitmap.
_orig = woff2.WOFF2GlyfTable.reconstruct


def _reconstruct(self, data, ttFont):
    _reserved, option_flags, num_glyphs = struct.unpack('>HHH', data[:6])
    if option_flags & 1:
        try:
            return _orig(self, data, ttFont)
        except Exception:
            data = data[:-((num_glyphs + 7) >> 3)]
    return _orig(self, data, ttFont)


woff2.WOFF2GlyfTable.reconstruct = _reconstruct

home = os.path.expanduser('~')
ROOTS = [
    os.environ.get('USAGE_BOARD_FONT_CACHE', ''),
    *glob.glob(os.path.join(os.environ.get('LOCALAPPDATA', home), 'Claude-Data', '*', 'Cache', 'Cache_Data')),
    os.path.join(os.environ.get('APPDATA', home), 'Claude', 'Cache', 'Cache_Data'),
    os.path.join(home, 'Library', 'Application Support', 'Claude', 'Cache', 'Cache_Data'),
    os.path.join(home, '.config', 'Claude', 'Cache', 'Cache_Data'),
]


def names(font):
    return ' '.join(str(r) for r in font['name'].names if r.nameID in (1, 2, 4, 6, 16, 17))


def load(data):
    """A TTFont when `data` holds a font (the cache wraps files in its own header), else None."""
    start = data.find(b'wOF2')
    if start < 0:
        return None
    try:
        return TTFont(io.BytesIO(data[start:]))
    except Exception:
        return None


def find():
    best = None
    for root in ROOTS:
        for path in glob.glob(os.path.join(root, '*')) if root else []:
            try:
                with open(path, 'rb') as fh:
                    head = fh.read(64)
                    if b'wOF2' not in head:
                        continue
                    font = load(head + fh.read())
            except OSError:
                continue
            if font is None or 'fvar' not in font:
                continue
            label = names(font)
            if 'Anthropic Sans' not in label or 'Italic' in label or not any(a.axisTag == 'wght' for a in font['fvar'].axes):
                continue
            if 'Text' in label:
                return font
            best = best or font
    return best


out = sys.argv[1]
if len(sys.argv) > 2:
    with open(sys.argv[2], 'rb') as fh:
        source = load(fh.read()) or TTFont(sys.argv[2])
else:
    source = find()
if source is None:
    print('build_font: no Anthropic Sans found in the Claude app cache', file=sys.stderr)
    sys.exit(1)

unicodes = list(range(0x20, 0x7F)) + [0xA0, 0xB7, 0xD7, 0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2026, 0x2212]
options = subset.Options()
options.layout_features = ['kern', 'liga', 'calt', 'ccmp', 'locl', 'mark', 'mkmk', 'clig', 'rlig', 'rclt', 'case', 'tnum']
options.name_IDs = [1, 2, 3, 4, 6]
options.notdef_outline = True
options.hinting = False
options.glyph_names = False
subsetter = subset.Subsetter(options)
subsetter.populate(unicodes=unicodes)
subsetter.subset(source)
if any(a.axisTag == 'opsz' for a in source['fvar'].axes):
    source = instancer.instantiateVariableFont(source, {'opsz': 16})  # the card's text is 16px or smaller
source.flavor = 'woff2'
os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
tmp = out + '.tmp'
source.save(tmp)
os.replace(tmp, out)
print(f'build_font: wrote {out} ({os.path.getsize(out)} bytes)')
