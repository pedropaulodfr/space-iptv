# -*- coding: utf-8 -*-
"""Gera os icones e o logo do splash do app Android a partir da arte do app Tizen.

Fonte unica de arte: tv/icon.png (512x512). O icone adaptativo (API 26+) usa um
recorte sem o texto "Space IPTV", porque o launcher aplica mascara na area segura.
"""
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "app", "icon.png")
RES = os.path.join(ROOT, "celular", "app", "src", "main", "res")

# lado do icone legado (dp) por densidade
DENS = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
# lado do icone adaptativo (108dp de canvas)
DENS108 = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}

SS = 4  # supersampling para bordas suaves


def rounded(img, radius_pct=0.22):
    w, h = img.size
    big = Image.new("RGBA", (w * SS, h * SS), (0, 0, 0, 0))
    big.paste(img.resize((w * SS, h * SS), Image.LANCZOS), (0, 0))
    mask = Image.new("L", (w * SS, h * SS), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, w * SS - 1, h * SS - 1], radius=int(w * SS * radius_pct), fill=255)
    big.putalpha(mask)
    return big.resize((w, h), Image.LANCZOS)


def circle(img):
    w, h = img.size
    big = Image.new("RGBA", (w * SS, h * SS), (0, 0, 0, 0))
    big.paste(img.resize((w * SS, h * SS), Image.LANCZOS), (0, 0))
    mask = Image.new("L", (w * SS, h * SS), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, w * SS - 1, h * SS - 1], fill=255)
    big.putalpha(mask)
    return big.resize((w, h), Image.LANCZOS)


def foreground(src):
    """Recorte quadrado sem o texto, com o conteudo dentro da area segura."""
    w, h = src.size
    cut = int(h * 0.762)            # acima do texto "Space IPTV"
    box = src.crop((0, 0, w, cut))
    bw, bh = box.size
    side = bh                      # quadrado a partir da altura do recorte
    left = max(0, (bw - side) // 2)
    box = box.crop((left, 0, left + side, side))
    return box


def main():
    src = Image.open(SRC).convert("RGBA")
    fg = foreground(src)

    for dens, size in DENS.items():
        d = os.path.join(RES, "mipmap-" + dens)
        os.makedirs(d, exist_ok=True)
        base = src.resize((size, size), Image.LANCZOS)
        rounded(base).save(os.path.join(d, "ic_launcher.png"), optimize=True)
        circle(base).save(os.path.join(d, "ic_launcher_round.png"), optimize=True)

    for dens, size in DENS108.items():
        d = os.path.join(RES, "mipmap-" + dens)
        os.makedirs(d, exist_ok=True)
        # area segura: conteudo ocupa ~80% do canvas de 108dp
        inner = int(size * 0.80)
        canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        canvas.paste(fg.resize((inner, inner), Image.LANCZOS),
                     ((size - inner) // 2, (size - inner) // 2))
        canvas.save(os.path.join(d, "ic_launcher_foreground.png"), optimize=True)

    anydpi = os.path.join(RES, "mipmap-anydpi-v26")
    os.makedirs(anydpi, exist_ok=True)

    nodpi = os.path.join(RES, "drawable-nodpi")
    os.makedirs(nodpi, exist_ok=True)
    src.resize((288, 288), Image.LANCZOS).save(
        os.path.join(nodpi, "splash_logo.png"), optimize=True)

    print("icones gerados em", RES)


if __name__ == "__main__":
    main()
