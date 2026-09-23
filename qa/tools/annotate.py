# Numbered markers and highlight boxes on a screenshot copy — the "circles and
# rectangles" that make a QA response PDF readable. Promoted from the per-package
# annotate.py used in the 09-01 … 09-11 rounds (22 Sep 2026); the skill's step 6
# calls it for every "after" screenshot.
#
# As a module (from the evidence dir, next to the PNGs):
#   from annotate import annotate, pad_left
#   pad_left('m4-rail.png', 'p4-rail.png')                       # white gutter for markers
#   annotate('p4-rail.png', 'm4-rail-marked.png',
#            markers=[(37, 268, 1), (37, 420, 2)],               # (x, y, number)
#            boxes=[(120, 240, 980, 300), (120, 400, 980, 470)])  # (x0, y0, x1, y1) rounded rectangles
#
# From the shell:
#   python ../tools/annotate.py src.png dst.png --marker 37,268,1 --marker 37,420,2 --box 120,240,980,300 [--gutter 74] [--radius 22]
#
# Coordinates are in the screenshot's own pixel space (shoot.mjs renders at 2x).
# Put markers in whitespace or the gutter beside what they point at, never on
# the words a tester has to read; pair each number with a callouts() legend
# line in report_content.py.
import os
import sys
from PIL import Image, ImageDraw, ImageFont

RED = (239, 68, 68)


def _font(size):
    for name in ('segoeuib.ttf', 'arialbd.ttf', 'arial.ttf'):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def pad_left(src, dst, gutter=74, bg=(255, 255, 255, 255)):
    """Add a white gutter on the left so markers can sit beside the content."""
    im = Image.open(src).convert('RGBA')
    out = Image.new('RGBA', (im.width + gutter, im.height), bg)
    out.paste(im, (gutter, 0), im)
    out.convert('RGB').save(dst)
    return out.size


def annotate(src, dst, markers=(), boxes=(), crop=None, radius=22, box_width=4, box_radius=10):
    """markers: (x, y, n) red discs with a white ring and the number.
    boxes: (x0, y0, x1, y1) red rounded rectangles around the thing to look at.
    crop: (x0, y0, x1, y1) applied first; coordinates are then shifted."""
    im = Image.open(src).convert('RGBA')
    if crop:
        im = im.crop(crop)
        markers = [(x - crop[0], y - crop[1], n) for x, y, n in markers]
        boxes = [(x0 - crop[0], y0 - crop[1], x1 - crop[0], y1 - crop[1]) for x0, y0, x1, y1 in boxes]
    layer = Image.new('RGBA', im.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for x0, y0, x1, y1 in boxes:
        # soft halo then the crisp outline — reads on white and on dark wells
        d.rounded_rectangle((x0 - 3, y0 - 3, x1 + 3, y1 + 3), radius=box_radius + 3, outline=RED + (70,), width=box_width + 4)
        d.rounded_rectangle((x0, y0, x1, y1), radius=box_radius, outline=RED + (255,), width=box_width)
    f = _font(int(radius * 1.25))
    for x, y, n in markers:
        d.ellipse((x - radius - 4, y - radius - 4, x + radius + 4, y + radius + 4), fill=RED + (70,))
        d.ellipse((x - radius, y - radius, x + radius, y + radius), fill=RED + (255,), outline=(255, 255, 255, 255), width=3)
        t = str(n)
        bb = d.textbbox((0, 0), t, font=f)
        d.text((x - (bb[2] - bb[0]) / 2 - bb[0], y - (bb[3] - bb[1]) / 2 - bb[1]), t, font=f, fill=(255, 255, 255, 255))
    Image.alpha_composite(im, layer).convert('RGB').save(dst)
    return dst


def _main(argv):
    if len(argv) < 2 or argv[0] in ('-h', '--help'):
        print(__doc__ or 'annotate.py src dst [--marker x,y,n]... [--box x0,y0,x1,y1]... [--gutter N] [--radius N]')
        return 1
    src, dst, rest = argv[0], argv[1], argv[2:]
    markers, boxes, gutter, radius = [], [], 0, 22
    i = 0
    while i < len(rest):
        flag, val = rest[i], rest[i + 1] if i + 1 < len(rest) else ''
        if flag == '--marker':
            x, y, n = val.split(','); markers.append((int(x), int(y), n))
        elif flag == '--box':
            boxes.append(tuple(int(v) for v in val.split(',')))
        elif flag == '--gutter':
            gutter = int(val)
        elif flag == '--radius':
            radius = int(val)
        i += 2
    if gutter:
        padded = dst + '.padded.png'
        pad_left(src, padded, gutter)
        src = padded
        markers = [(x + gutter, y, n) for x, y, n in markers]
        boxes = [(x0 + gutter, y0, x1 + gutter, y1) for x0, y0, x1, y1 in boxes]
    annotate(src, dst, markers, boxes, radius=radius)
    if gutter:
        os.remove(src)
    print('annotated ->', dst)
    return 0


if __name__ == '__main__':
    sys.exit(_main(sys.argv[1:]))
