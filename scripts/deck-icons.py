"""Generate the icon set for WARDOGS Deck (Tauri source icon + Stream Deck
plugin images). Run once; outputs are committed.

    python scripts/deck-icons.py
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
PLUGIN = ROOT / "streamdeck-plugin" / "com.davidwallace.wardogs.sdPlugin" / "imgs"
TAURI = ROOT / "src-tauri" / "icons"

BG = (21, 27, 34)
RING = (143, 209, 168)
CROSS = (255, 255, 255)
ACCENT = (255, 138, 128)
MUTED = (159, 179, 200)


def font(size):
    for name in ("segoeuib.ttf", "arialbd.ttf", "DejaVuSans-Bold.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def crosshair(size, ring=RING, cross=CROSS, bg=BG, rounded=True):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = size * 0.06
    if rounded:
        d.rounded_rectangle([pad, pad, size - pad, size - pad], radius=size * 0.18, fill=bg)
    c = size / 2
    r = size * 0.28
    w = max(2, int(size * 0.045))
    d.ellipse([c - r, c - r, c + r, c + r], outline=ring, width=w)
    gap = size * 0.09
    d.line([c, c - r - gap * 1.2, c, c - gap], fill=cross, width=w)
    d.line([c, c + gap, c, c + r + gap * 1.2], fill=cross, width=w)
    d.line([c - r - gap * 1.2, c, c - gap, c], fill=cross, width=w)
    d.line([c + gap, c, c + r + gap * 1.2, c], fill=cross, width=w)
    dot = size * 0.035
    d.ellipse([c - dot, c - dot, c + dot, c + dot], fill=ACCENT)
    return img


def glyph_card(size, text, color=CROSS, label=None):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = size * 0.04
    d.rounded_rectangle([pad, pad, size - pad, size - pad], radius=size * 0.14, fill=BG,
                        outline=(43, 58, 74), width=max(1, int(size * 0.03)))
    f = font(int(size * (0.34 if len(text) <= 2 else 0.22)))
    box = d.textbbox((0, 0), text, font=f)
    tw, th = box[2] - box[0], box[3] - box[1]
    y = size * (0.42 if label else 0.5) - th / 2 - box[1]
    d.text(((size - tw) / 2 - box[0], y), text, font=f, fill=color)
    if label:
        lf = font(int(size * 0.12))
        lb = d.textbbox((0, 0), label, font=lf)
        d.text(((size - (lb[2] - lb[0])) / 2 - lb[0], size * 0.72 - lb[1]), label, font=lf, fill=MUTED)
    return img


def save(img, base, sizes):
    base.parent.mkdir(parents=True, exist_ok=True)
    small, large = sizes
    img.resize((small, small), Image.LANCZOS).save(f"{base}.png")
    img.resize((large, large), Image.LANCZOS).save(f"{base}@2x.png")


def main():
    master = crosshair(1024)

    # Tauri source icon (npx tauri icon expands it into every platform size).
    TAURI.mkdir(parents=True, exist_ok=True)
    master.save(TAURI / "source.png")

    # Plugin + category icon.
    save(master, PLUGIN / "plugin-icon", (256, 512))

    cards = {
        "axis": ("X/Y", "DIAL"),
        "result": ("MIL", "AZ · DIST"),
        "weapon": ("L81", "WEAPON"),
        "swap": ("A<>T", "SWAP"),
        "save": ("SAVE", "TARGET"),
        "step": ("NEXT", "TARGET"),
        "app": ("WD", "APP"),
    }
    for name, (text, label) in cards.items():
        # Action-list icon: glyph only, tiny.
        save(glyph_card(512, text), PLUGIN / f"{name}-icon", (20, 40))
        # Default key image before the plugin paints a live one.
        save(glyph_card(512, text, label=label), PLUGIN / f"{name}-key", (72, 144))

    print("icons written to", PLUGIN, "and", TAURI)


if __name__ == "__main__":
    main()
