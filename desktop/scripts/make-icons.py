#!/usr/bin/env python
"""Gera os ícones do Space IPTV Desktop a partir de tv/icon.png.

Saída em desktop/build/:
  icon.png          512x512 (fonte para o electron-builder)
  icon.ico          multi-resolução 16..256 (app, instalador e bandeja)
  icon-tray.png     32x32 (fallback de bandeja)
  icon-256.png      256x256 (atalhos/README)

Sem dependência além de Pillow. Fundo padrão --spaceBlack (#050711).
Uso: python scripts/make-icons.py
"""
import os
import sys

from PIL import Image

DESKTOP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.dirname(DESKTOP)
SRC = os.path.join(ROOT, "tv", "icon.png")
OUT_DIR = os.path.join(DESKTOP, "build")
BG = (5, 7, 17, 255)  # --spaceBlack

ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]


def square(img: Image.Image, size: int = 1024) -> Image.Image:
    img = img.convert("RGBA")
    w, h = img.size
    side = max(w, h)
    canvas = Image.new("RGBA", (side, side), BG)
    canvas.paste(img, ((side - w) // 2, (side - h) // 2), img if img.mode == "RGBA" else None)
    return canvas.resize((size, size), Image.LANCZOS)


def main() -> int:
    if not os.path.isfile(SRC):
        print("[make-icons] fonte não encontrada: " + SRC, file=sys.stderr)
        return 1
    os.makedirs(OUT_DIR, exist_ok=True)
    base = square(Image.open(SRC), 1024)
    base.resize((512, 512), Image.LANCZOS).save(os.path.join(OUT_DIR, "icon.png"), "PNG")
    base.resize((256, 256), Image.LANCZOS).save(os.path.join(OUT_DIR, "icon-256.png"), "PNG")
    base.resize((32, 32), Image.LANCZOS).save(os.path.join(OUT_DIR, "icon-tray.png"), "PNG")
    base.save(os.path.join(OUT_DIR, "icon.ico"), sizes=[(s, s) for s in ICO_SIZES])
    print("[make-icons] gerado em " + OUT_DIR + ": icon.ico, icon.png, icon-256.png, icon-tray.png")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
