"""Generate Chiefton app icon (blue diamond crest).

Run once to regenerate icon.png + icon.ico. Not part of the build pipeline —
this is a developer utility.
"""
from PIL import Image, ImageDraw

SIZE = 512
BG_TOP = (58, 99, 153)      # #3A6399 accent-hover
BG_BOT = (34, 61, 94)       # #223D5E accent-pressed
FG = (245, 240, 230)        # warm cream


def make_icon(size):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Radial gradient background — rounded square
    radius = int(size * 0.22)
    grad = Image.new('RGB', (size, size), BG_TOP)
    g = ImageDraw.Draw(grad)
    for i in range(size):
        t = i / size
        r = int(BG_TOP[0] * (1 - t) + BG_BOT[0] * t)
        g_ = int(BG_TOP[1] * (1 - t) + BG_BOT[1] * t)
        b = int(BG_TOP[2] * (1 - t) + BG_BOT[2] * t)
        g.line([(0, i), (size, i)], fill=(r, g_, b))

    # Rounded-square mask
    mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size, size], radius=radius, fill=255)
    img.paste(grad, (0, 0), mask)

    draw = ImageDraw.Draw(img)
    cx = cy = size // 2

    # Crest shape — stylized diamond / chevron
    pad = size * 0.22
    top = (cx, cy - size * 0.28)
    bot = (cx, cy + size * 0.30)
    left = (cx - size * 0.24, cy - size * 0.02)
    right = (cx + size * 0.24, cy - size * 0.02)

    # Outer diamond stroke
    stroke_w = max(int(size * 0.035), 4)
    draw.line([top, left, bot, right, top], fill=FG, width=stroke_w, joint='curve')

    # Inner chevron — a V inside the diamond
    v_top_l = (cx - size * 0.14, cy - size * 0.10)
    v_top_r = (cx + size * 0.14, cy - size * 0.10)
    v_bot = (cx, cy + size * 0.14)
    draw.line([v_top_l, v_bot, v_top_r], fill=FG, width=stroke_w, joint='curve')

    return img


if __name__ == '__main__':
    import os
    here = os.path.dirname(__file__)

    # Main PNG (512×512 is the canonical Electron source)
    big = make_icon(SIZE)
    big.save(os.path.join(here, 'icon.png'))

    # Windows .ico — multi-resolution
    sizes = [256, 128, 64, 48, 32, 16]
    icons = [make_icon(s) for s in sizes]
    icons[0].save(
        os.path.join(here, 'icon.ico'),
        format='ICO',
        sizes=[(s, s) for s in sizes],
    )
    print('wrote icon.png (512x512) and icon.ico (multi-res)')
