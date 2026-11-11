# -*- coding: utf-8 -*-
"""
Fill Samsung's "App Description" template (eng v1.42) for Space IPTV.

Keeps the original master/layout, deletes the guidance + sample slides and writes
the real content: UI structure (tree, flow graph, layers), usage scenario,
menu & function description (with store screenshots), key policy, languages and
test instructions.

Usage:
    python tools/fill_app_description.py <template.pptx> <out.pptx>
"""
import copy
import re
import sys

from lxml import etree
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_CONNECTOR, MSO_SHAPE, MSO_SHAPE_TYPE
from pptx.enum.text import MSO_ANCHOR, MSO_AUTO_SIZE, PP_ALIGN
from pptx.oxml.ns import qn
from pptx.util import Emu, Inches, Pt

TEMPLATE = sys.argv[1]
OUT = sys.argv[2]
ROOT = "D:/Documentos/projects/IPTV-Tizen/"
IMGS = ROOT + "dist/store/images/"

FONT = None  # inherit the theme font of the template
INK = RGBColor(0x22, 0x33, 0x38)
GREY = RGBColor(0x5A, 0x6B, 0x72)
TEAL = RGBColor(0x14, 0x64, 0x7F)
GREEN = RGBColor(0x2E, 0x7D, 0x32)

# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #


def ph_shape(slide, idx=0):
    """First placeholder (idx 0 = title on these layouts)."""
    for sh in slide.shapes:
        if sh.is_placeholder and sh.placeholder_format.idx == idx:
            return sh
    raise KeyError("placeholder %d not found" % idx)


def drop(shape):
    shape._element.getparent().remove(shape._element)


def delete_slide(prs, slide):
    sldIdLst = prs.slides._sldIdLst
    for sldId in list(sldIdLst):
        if int(sldId.get("id")) == slide.slide_id:
            rId = sldId.get(qn("r:id"))
            sldIdLst.remove(sldId)
            prs.part.drop_rel(rId)
            return


def move_slide(prs, slide, new_index):
    sldIdLst = prs.slides._sldIdLst
    for sldId in list(sldIdLst):
        if int(sldId.get("id")) == slide.slide_id:
            sldIdLst.remove(sldId)
            sldIdLst.insert(new_index, sldId)
            return


def add_slide_like(prs, src):
    """New slide on the same layout, with copies of the src text placeholders."""
    new = prs.slides.add_slide(src.slide_layout)
    for sh in list(new.shapes):
        drop(sh)
    for sh in src.shapes:
        if sh.shape_type == MSO_SHAPE_TYPE.PLACEHOLDER and sh.has_text_frame:
            new.shapes._spTree.append(copy.deepcopy(sh._element))
    return new


def clear_frame(tf):
    txBody = tf._txBody
    for p in txBody.findall(qn("a:p"))[1:]:
        txBody.remove(p)
    first = txBody.find(qn("a:p"))
    for child in list(first):
        if child.tag in (qn("a:r"), qn("a:br"), qn("a:fld")):
            first.remove(child)
    return first


ALIGN_XML = {PP_ALIGN.LEFT: "l", PP_ALIGN.CENTER: "ctr", PP_ALIGN.RIGHT: "r"}


def write(shape, lines, default_size=13, default_color=INK, align=None):
    """lines: list of dicts {t, size, b, i, color, indent, space, align, font}."""
    tf = shape.text_frame
    tf.word_wrap = True
    tf.auto_size = MSO_AUTO_SIZE.NONE
    tf.vertical_anchor = MSO_ANCHOR.TOP
    body = tf._txBody
    old = [p for p in body.findall(qn("a:p"))]
    for p in old:
        body.remove(p)
    for spec in lines:
        p = etree.SubElement(body, qn("a:p"))
        pPr = etree.SubElement(p, qn("a:pPr"))
        pPr.set("marL", str(int(spec.get("indent", 0))))
        pPr.set("indent", "0")
        if spec.get("align") or align:
            pPr.set("algn", ALIGN_XML.get(spec.get("align") or align,
                                          spec.get("align") or align))
        if spec.get("space"):
            spc = etree.SubElement(pPr, qn("a:spcBef"))
            pts = etree.SubElement(spc, qn("a:spcPts"))
            pts.set("val", str(int(spec["space"] * 100)))
        etree.SubElement(pPr, qn("a:buNone"))
        r = etree.SubElement(p, qn("a:r"))
        rPr = etree.SubElement(r, qn("a:rPr"))
        size = spec.get("size", default_size)
        rPr.set("lang", "en-US")
        rPr.set("sz", str(int(size * 100)))
        rPr.set("b", "1" if spec.get("b") else "0")
        rPr.set("i", "1" if spec.get("i") else "0")
        rPr.set("dirty", "0")
        fill = etree.SubElement(rPr, qn("a:solidFill"))
        clr = etree.SubElement(fill, qn("a:srgbClr"))
        clr.set("val", str(spec.get("color", default_color)))
        if spec.get("font"):
            latin = etree.SubElement(rPr, qn("a:latin"))
            latin.set("typeface", spec["font"])
        t = etree.SubElement(r, qn("a:t"))
        t.text = spec["t"]
    return tf


def L(text, **kw):
    d = {"t": text}
    d.update(kw)
    return d


def set_cell(cell, text, size=11, bold=False, color=INK, italic=False,
             align=PP_ALIGN.LEFT, font=None):
    cell.vertical_anchor = MSO_ANCHOR.MIDDLE
    cell.margin_left = Inches(0.08)
    cell.margin_right = Inches(0.08)
    cell.margin_top = Inches(0.03)
    cell.margin_bottom = Inches(0.03)
    tf = cell.text_frame
    tf.word_wrap = True
    body = tf._txBody
    for p in body.findall(qn("a:p")):
        body.remove(p)
    parts = text.split("\n")
    for k, part in enumerate(parts):
        p = etree.SubElement(body, qn("a:p"))
        pPr = etree.SubElement(p, qn("a:pPr"))
        pPr.set("algn", {PP_ALIGN.LEFT: "l", PP_ALIGN.CENTER: "ctr",
                         PP_ALIGN.RIGHT: "r"}[align])
        etree.SubElement(pPr, qn("a:buNone"))
        r = etree.SubElement(p, qn("a:r"))
        rPr = etree.SubElement(r, qn("a:rPr"))
        rPr.set("lang", "en-US")
        rPr.set("sz", str(int(size * 100)))
        rPr.set("b", "1" if bold else "0")
        rPr.set("i", "1" if italic else "0")
        rPr.set("dirty", "0")
        fill = etree.SubElement(rPr, qn("a:solidFill"))
        clr = etree.SubElement(fill, qn("a:srgbClr"))
        clr.set("val", str(color))
        if font:
            latin = etree.SubElement(rPr, qn("a:latin"))
            latin.set("typeface", font)
        t = etree.SubElement(r, qn("a:t"))
        t.text = part


def table_add_row(table):
    tr = copy.deepcopy(table._tbl.tr_lst[-1])
    table._tbl.append(tr)
    return _RowRef(table, len(table._tbl.tr_lst) - 1)


class _RowRef(object):
    """Row proxy: python-pptx rows do not accept negative indexes."""

    def __init__(self, table, idx):
        self.cells = table.rows[idx].cells


def table_del_row(table, idx):
    tr = table._tbl.tr_lst[idx]
    table._tbl.remove(tr)


def table_width(table, widths):
    for col, w in zip(table.columns, widths):
        col.width = Inches(w)


BORDER = RGBColor(0xB8, 0xC4, 0xC9)


def paint_table(table, head_fill, body_fill, border=BORDER):
    """Explicit cell fills + thin borders (overrides the theme table style)."""
    for r, row in enumerate(table.rows):
        for cell in row.cells:
            cell.fill.solid()
            cell.fill.fore_color.rgb = head_fill if r == 0 else body_fill
            tcPr = cell._tc.get_or_add_tcPr()
            for i, tag in enumerate(("a:lnL", "a:lnR", "a:lnT", "a:lnB")):
                if tcPr.find(qn(tag)) is not None:
                    continue
                ln = etree.Element(qn(tag))
                ln.set("w", "9525")
                ln.set("cap", "flat")
                ln.set("cmpd", "sng")
                ln.set("algn", "ctr")
                fill = etree.SubElement(ln, qn("a:solidFill"))
                clr = etree.SubElement(fill, qn("a:srgbClr"))
                clr.set("val", str(border))
                etree.SubElement(ln, qn("a:prstDash")).set("val", "solid")
                tcPr.insert(i, ln)


def box(slide, x, y, w, h, text, size=10.5, fill=RGBColor(0xE6, 0xF2, 0xF6),
        ink=INK, bold=False, shape=MSO_SHAPE.ROUNDED_RECTANGLE, line=TEAL):
    sh = slide.shapes.add_shape(shape, Inches(x), Inches(y), Inches(w), Inches(h))
    sh.fill.solid()
    sh.fill.fore_color.rgb = fill
    sh.line.color.rgb = line
    sh.line.width = Pt(1.0)
    sh.shadow.inherit = False
    for st in sh._element.findall(qn("p:style")):
        sh._element.remove(st)
    tf = sh.text_frame
    tf.word_wrap = True
    tf.margin_left = tf.margin_right = Inches(0.04)
    tf.margin_top = tf.margin_bottom = Inches(0.02)
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    body = tf._txBody
    for p in body.findall(qn("a:p")):
        body.remove(p)
    p = etree.SubElement(body, qn("a:p"))
    pPr = etree.SubElement(p, qn("a:pPr"))
    pPr.set("algn", "ctr")
    etree.SubElement(pPr, qn("a:buNone"))
    r = etree.SubElement(p, qn("a:r"))
    rPr = etree.SubElement(r, qn("a:rPr"))
    rPr.set("lang", "en-US")
    rPr.set("sz", str(int(size * 100)))
    rPr.set("b", "1" if bold else "0")
    fill_el = etree.SubElement(rPr, qn("a:solidFill"))
    clr = etree.SubElement(fill_el, qn("a:srgbClr"))
    clr.set("val", str(ink))
    t = etree.SubElement(r, qn("a:t"))
    t.text = text
    return sh


def arrow(slide, x1, y1, x2, y2, color=RGBColor(0x7A, 0x8B, 0x94)):
    conn = slide.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, Inches(x1),
                                      Inches(y1), Inches(x2), Inches(y2))
    conn.line.color.rgb = color
    conn.line.width = Pt(1.25)
    ln = conn.line._get_or_add_ln()
    tail = etree.SubElement(ln, qn("a:tailEnd"))
    tail.set("type", "triangle")
    tail.set("w", "med")
    tail.set("len", "med")
    return conn


def picture(slide, path, x, y, w=None, h=None):
    kw = {}
    if w:
        kw["width"] = Inches(w)
    if h:
        kw["height"] = Inches(h)
    return slide.shapes.add_picture(path, Inches(x), Inches(y), **kw)


def hang_numbers(shape, mar_l=0.45, hang=0.2):
    """Outdent the step numbers so wrapped lines align with the text."""
    for p in shape.text_frame.paragraphs:
        pPr = p._p.get_or_add_pPr()
        if re.match(r"^\d+\.\s", p.text):
            pPr.set("marL", str(int(Inches(mar_l))))
            pPr.set("indent", str(-int(Inches(hang))))


def note_line(slide, x, y, w, text, size=11, color=GREY, bold=False):
    tb = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(0.3))
    write(tb, [L(text, size=size, color=color, b=bold)])
    tb.text_frame.auto_size = None
    return tb


# --------------------------------------------------------------------------- #
prs = Presentation(TEMPLATE)
S = prs.slides
title_s, rev_s, toc_s, ui_s, flow_s, scen_s, s9, menu_s, keys_s, lang_s = [
    S[i] for i in (1, 2, 3, 4, 5, 7, 8, 9, 10, 11)
]
guide_s, depth_s = S[0], S[6]

# ---------------------------------------------------------------- title slide
write(title_s.shapes[0], [L("Space IPTV Description", size=44, color=RGBColor(0x7F, 0xE3, 0xEE), b=True)])
write(title_s.shapes[1], [L("Pedro Paulo Franco", size=25,
                            color=RGBColor(0xFF, 0xFF, 0xFF), align=PP_ALIGN.RIGHT)])

# ------------------------------------------------------------ revision history
write(rev_s.shapes[0], [L("Revision History", size=30)])
t = rev_s.shapes[1].table
table_del_row(t, 2)
table_width(t, [0.9, 1.35, 5.35, 1.75])
hdr = ["Version", "Date", "Description", "Author"]
for i, v in enumerate(hdr):
    set_cell(t.cell(0, i), v, size=11, bold=True, align=PP_ALIGN.CENTER)
vals = ["1.0", "2026.11.05",
        "Initial document for Samsung certification.\nApp version 1.0.0 — package SpaceIPTV.wgt (Samsung signed).",
        "Pedro Paulo Franco"]
for i, v in enumerate(vals):
    set_cell(t.cell(1, i), v, size=11, align=PP_ALIGN.CENTER if i < 2 else PP_ALIGN.LEFT)
paint_table(t, RGBColor(0xEC, 0xF1, 0xF3), RGBColor(0xFF, 0xFF, 0xFF))
for row in t.rows:
    row.height = Inches(0.42)

# -------------------------------------------------------------------- contents
write(toc_s.shapes[0], [L("Contents", size=30)]); write(toc_s.shapes[1], [
    L("UI Structure  (navigation tree · screen flow · layers)", size=20, space=6),
    L("Usage Scenario", size=20, space=6),
    L("Menu & function description", size=20, space=6),
    L("Key Policy", size=20, space=6),
    L("How to change languages", size=20, space=6),
    L("Test instructions", size=20, space=6),
])

# ------------------------------------------------------- UI structure: tree
write(ui_s.shapes[0], [L("UI Structure — navigation tree", size=30)])
write(ui_s.shapes[1], [
    L("Single page application, 1920×1080, remote control only. Shell always on screen: navigation bar (left) · top bar "
      "(clock, active list, status) · hint bar (bottom).", size=12, b=True),
    L("", size=6),
    L("1  Início (Home) — Continuar assistindo · Canais favoritos · TV ao vivo · Filmes/Séries recentes · Acesso rápido", size=11.5),
    L("2  TV ao vivo (Live) — categories + channel grid (3 columns) · health dot on every channel · INFO = channel health", size=11.5),
    L("3  Filmes (Movies) — categories + poster grid (5 columns)", size=11.5),
    L("4  Séries (Series) — categories + poster grid (5 columns)", size=11.5),
    L("5  Pesquisa (Search) — text field + on-screen keyboard · filters Todos / Canais / Filmes / Séries", size=11.5),
    L("6  Favoritos — same grid, only the items saved as favourite in the active list", size=11.5),
    L("7  Configurações (Settings) — list manager (left) + actions (right)", size=11.5),
    L("├  + Adicionar lista M3U (URL)   ·   + Adicionar Xtream Codes (server, user, password)", size=11.5, indent=228600),
    L("├  Usar esta lista · Atualizar agora · Editar · Excluir · Limpar histórico", size=11.5, indent=228600),
    L('├  Toggle "Iniciar no último canal assistido" — default OFF', size=11.5, indent=228600),
    L('├  Toggle "Monitoramento da saúde dos canais" — default ON', size=11.5, indent=228600),
    L("└  Controle parental → PIN pad: set/change PIN · enable/disable the lock · unlock now", size=11.5, indent=228600),
    L("", size=6),
    L("Overlays, always on top of the current screen: Detalhes · Player · Dialogs · On-screen keyboard / PIN pad", size=12, b=True),
    L("BACK closes the top layer only. EXIT always asks for confirmation before closing the app.", size=12, color=GREY),
])

# -------------------------------------------------- UI structure: flow graph
drop(flow_s.shapes[1])
write(flow_s.shapes[0], [L("UI Structure — screen flow", size=30)])
COLX = [0.55, 2.05, 3.55, 5.05, 6.55, 8.05]
BW, BH = 1.35, 0.46
ROWY = [2.15, 2.78, 3.41, 4.04, 4.67, 5.30]
PATHS = [
    ["App start", "Início (Home)", "TV ao vivo", "Player · live"],
    ["", "Início (Home)", "Filmes", "Detalhes do filme", "Player · movie"],
    ["", "Início (Home)", "Séries", "Detalhes da série", "Temporadas/Episódios", "Player · episode"],
    ["", "Início (Home)", "Pesquisa", "Resultados", "Detalhes / Player"],
    ["", "Início (Home)", "Favoritos", "Detalhes / Player"],
    ["", "Configurações", "Formulário da lista", "Download do catálogo", "volta ao Início"],
]
for r, path in enumerate(PATHS):
    y = ROWY[r]
    for c, label in enumerate(path):
        if not label:
            continue
        fill = RGBColor(0x14, 0x64, 0x7F) if "Player" in label else RGBColor(0xE6, 0xF2, 0xF6)
        ink = RGBColor(0xFF, 0xFF, 0xFF) if "Player" in label else INK
        box(flow_s, COLX[c], y, BW, BH, label, size=10, fill=fill, ink=ink)
        if c + 1 < len(path) and path[c + 1]:
            arrow(flow_s, COLX[c] + BW + 0.02, y + BH / 2, COLX[c + 1] - 0.02, y + BH / 2)
note_line(flow_s, 0.55, 5.95, 8.9,
          "Within a screen: ◄ previous zone · ► next zone · OK opens the focused item · BACK returns one level.", size=10.5)
note_line(flow_s, 0.55, 6.27, 8.9,
          "Keys 1–9 open the 1st–9th favourite channel from any screen (the player keeps them during live playback).", size=10.5)
note_line(flow_s, 0.55, 6.59, 8.9,
          "First launch without any list opens Configurações; Início appears as soon as a list is active.", size=10.5)

# ------------------------------------------- UI structure: layers (new slide)
layers_s = add_slide_like(prs, ui_s)
write(layers_s.shapes[0], [L("UI Structure — layers and overlays", size=30)])
write(layers_s.shapes[1], [
    L("The app is one HTML page. Sections are swapped inside the content area; the navigation bar and the top bar never reload.", size=13),
    L("Key events go to a stack of layers and only the top layer receives them, so BACK always closes exactly one level.", size=13, space=8),
    L("· Screen: Início, TV ao vivo, Filmes, Séries, Pesquisa, Favoritos, Configurações — one at a time, left bar shows the active one.", size=12.5, space=6, indent=228600),
    L("· Overlay 1 — Detalhes: poster, metadata, plot, buttons (Assistir / Continuar, Favoritar, Voltar) and, for series, season chips + episode list.", size=12.5, space=6, indent=228600),
    L("· Overlay 2 — Player: full screen AVPlay surface, info bar (title, AO VIVO badge, hints), channel list panel (live) and an error panel with retry.", size=12.5, space=6, indent=228600),
    L("· Overlay 3 — Dialogs: confirm (exit, delete list, clear history), alert (channel health legend) and form (add / edit list).", size=12.5, space=6, indent=228600),
    L("· Overlay 4 — Keyboards: on-screen keyboard for URL / user / password and a numeric pad for the 4-digit parental PIN.", size=12.5, space=6, indent=228600),
    L("Focus is always visible (outline + scale), so every action is reachable with the D-Pad only — no mouse, no physical keyboard required.", size=13, space=10),
    L("Toasts (bottom) confirm actions such as favourite added, list saved, parental control changed.", size=13, space=8, color=GREY),
])

# ----------------------------------------------------------- usage scenario 1
write(scen_s.shapes[0], [L("Usage Scenario (1/2) — first run and adding a playlist", size=25)])
write(scen_s.shapes[1], [
    L("Space IPTV is a player: it has no login, no account and no content of its own. A playlist must be provided by the user "
      "(M3U URL or Xtream Codes account).", size=12, b=True, color=TEAL),
    L("1.  Start the app. A loading screen is shown while the local data is read, then Início opens. With no playlist registered the app "
      "opens Configurações and shows the message “Adicione uma lista para começar”.", size=12, space=8, indent=228600),
    L("2.  In Configurações press ► to move to the actions and select “+  Adicionar lista M3U (URL)”.", size=12, space=6, indent=228600),
    L("3.  Fill “Nome da lista” and “URL M3U”. Text is typed with the on-screen keyboard (arrows + OK) or with the Samsung keyboard; "
      "OK on “Salvar”. The URL must start with http:// or https://.", size=12, space=6, indent=228600),
    L("4.  For Xtream Codes select “+  Adicionar Xtream Codes”: name, server (http://host:port), user and password. The credentials are "
      "validated online before saving and a clear message is shown if the server refuses them.", size=12, space=6, indent=228600),
    L("5.  The catalog starts downloading: the top bar shows “Atualizando 42%”. Only the active list is downloaded; the parsed catalog is "
      "stored on the device (IndexedDB) and reused on the next launch.", size=12, space=6, indent=228600),
    L("6.  Back to Início: the rows fill automatically as soon as the data is ready. Without internet the stored catalog is used and the top "
      "bar shows “Sem internet • dados salvos”.", size=12, space=6, indent=228600),
])

# ----------------------------------------------------------- usage scenario 2
drop(s9.shapes[2])  # sample login picture
write(s9.shapes[0], [L("Usage Scenario (2/2) — watching, shortcuts and parental control", size=25)])
write(s9.shapes[1], [
    L("1.  Início: ▲▼ moves between rows, ◄► inside a row, OK on a channel card plays it directly.", size=12, space=6, indent=228600),
    L("2.  TV ao vivo: ◄ selects a category, ► enters the grid, OK plays the channel. After ~3 s the health dots appear on the channels.", size=12, space=6, indent=228600),
    L("3.  Player (live): ▲▼ or CH▲▼ zap · OK opens the channel list · YELLOW adds/removes the favourite · BLUE swaps to the previous channel · "
      "INFO shows the info bar · BACK returns to the grid.", size=12, space=6, indent=228600),
    L("4.  Filmes / Séries: OK opens Detalhes, OK on “Assistir” plays. For a series ◄► chooses the season and ▼ goes to the episode list. "
      "In playback: OK pauses, ◄► seek ±10 s, ▶▶ / ◀◀ seek ±30 s.", size=12, space=6, indent=228600),
    L("5.  Number keys 1–9 open the 1st to 9th favourite channel from any screen — the badge on the card shows which number it is.", size=12, space=6, indent=228600),
    L("6.  Configurações → Controle parental → “Definir senha”: type 4 digits twice on the PIN pad. Afterwards the lock can be enabled or "
      "disabled (PIN required) and “Liberar conteúdo adulto agora” unlocks it until the app is closed.", size=12, space=6, indent=228600),
    L("7.  While the lock is on, adult categories and items are removed from TV ao vivo, Filmes, Séries, Pesquisa, Favoritos and "
      "“Continuar assistindo”.", size=12, space=6, indent=228600),
    L("8.  “Iniciar no último canal assistido” (default OFF): when ON the last live channel is played again at start — never an adult channel.", size=12, space=6, indent=228600),
    L("9.  EXIT, or BACK on the navigation bar, opens “Deseja fechar o Space IPTV?”. “Sair” closes the app and returns to the TV broadcast.", size=12, space=6, indent=228600),
])

# ------------------------------------------- menu & function (4 screenshots)
MENU = [
    ("Início (Home)", "01-inicio.jpg", [
        "Persistent navigation bar on the left; the current section is highlighted.",
        "Top bar: clock, name of the active list and the catalog status (“Atualizada”, “Atualizando 42%”, “Sem internet • dados salvos”).",
        "Rows come only from the active list: Continuar assistindo, Canais favoritos, TV ao vivo, Filmes/Séries recentes, Acesso rápido.",
        "▲▼ changes row, ◄► changes card, OK opens. YELLOW or holding OK adds/removes the favourite.",
        "The numbered badge marks the favourite channels reachable with keys 1–9.",
    ]),
    ("TV ao vivo (Live)", "02-tv-ao-vivo.jpg", [
        "Left: categories of the active list, each with the number of items.",
        "Right: channel grid (3 columns) with the logos provided by the playlist.",
        "Health dot per channel: green = fast, yellow = slow answer, orange = very slow or error, red = failed after retry, gray = not checked.",
        "The real playback result is also used: a channel that played is shown as green.",
        "INFO opens the health details of the focused channel. Monitoring can be switched off in Configurações.",
    ]),
    ("Detalhes de série (Details)", "03-serie.jpg", [
        "Poster, year / age rating / duration / score badges and the plot sent by the list.",
        "Buttons: Assistir (or Continuar mm:ss), Favoritar and Voltar.",
        "Series: season chips (◄►) and the episode list (▼); the episode in progress is marked.",
        "BACK closes the details and returns to the exact position in the grid.",
    ]),
    ("Configurações (Settings)", "04-configuracoes.jpg", [
        "Left: registered lists — the active one is flagged ATIVA, with type and last update.",
        "Right: add M3U / Xtream, use this list, refresh now, edit, delete, clear history.",
        "Two toggles: “Iniciar no último canal assistido” (default OFF) and “Monitoramento da saúde dos canais” (default ON). Both apply immediately.",
        "“🔒 Controle parental” opens the PIN pad.",
        "About text: player only, no content included, passwords encrypted on the device.",
    ]),
]

menu_slides = [menu_s]
for _ in MENU[1:]:
    menu_slides.append(add_slide_like(prs, menu_s))

for slide, (title, img, bullets) in zip(menu_slides, MENU):
    write(slide.shapes[0], [L("Menu & function description — " + title, size=24)])
    for sh in list(slide.shapes):
        if sh.shape_type == MSO_SHAPE_TYPE.PICTURE:
            drop(sh)
    body = slide.shapes[1]
    drop(body)
    picture(slide, IMGS + img, 0.55, 2.05, w=5.7)
    tb = slide.shapes.add_textbox(Inches(6.45), Inches(2.05), Inches(3.0), Inches(4.6))
    write(tb, [L("· " + b, size=10.5, space=7) for b in bullets])

# ----------------------------------------------------------------- key policy
write(keys_s.shapes[0], [L("Key Policy", size=30)])
write(keys_s.shapes[1], [
    L("The app is operated with the Samsung remote only (D-Pad, OK, colour keys, numbers, channel keys, media keys).", size=12, color=GREY),
])
kt = keys_s.shapes[2].table
table_del_row(kt, 0)
while len(kt.rows) > 1:
    table_del_row(kt, len(kt.rows) - 1)
KEYS = [
    ("ENTER / OK", "Selects the focused item. Live playback: opens the channel list. Movie: pauses / resumes.", "Holding 0.7 s = favourite"),
    ("UP / DOWN", "Moves the focus vertically. Live playback: next / previous channel.", ""),
    ("LEFT / RIGHT", "Moves the focus; LEFT on a screen opens the navigation bar. Playback: −10 s / +10 s.", ""),
    ("CH UP / CH DOWN", "Live playback: next / previous channel. No function on the other screens.", ""),
    ("Number keys 1–9", "Opens the 1st to 9th favourite channel from any screen (shortcut).", "Shown on the card"),
    ("Number key 0", "Used only by the 4-digit parental PIN pad. No other function.", ""),
    ("YELLOW", "Adds / removes the focused item from the favourites of the active list.", ""),
    ("BLUE", "Swaps between the current and the previous live channel.", "Live only"),
    ("RED", "Cancels and closes the current dialog / PIN pad.", ""),
    ("INFO", "Channel health dialog (Live screen) or the player info bar.", ""),
    ("PLAY / PAUSE", "Pauses or resumes; PLAY also retries a stream that failed.", ""),
    ("FF / RW", "Seeks +30 s / −30 s in movies and episodes.", ""),
    ("RETURN", "Closes the top layer; on the navigation bar it opens the exit confirmation.", "Samsung Mandatory"),
    ("EXIT", 'Closes the app after the dialog “Deseja fechar o Space IPTV?”.', "Samsung Mandatory"),
]
for k, act, rem in KEYS:
    r = table_add_row(kt)
    set_cell(r.cells[0], k, size=8.5, bold=True)
    set_cell(r.cells[1], act, size=8.5)
    set_cell(r.cells[2], rem, size=8.5, color=GREY)
for i, v in enumerate(["Button", "Action", "Remarks"]):
    set_cell(kt.cell(0, i), v, size=10, bold=True, align=PP_ALIGN.CENTER)
table_width(kt, [1.45, 5.35, 2.2])
for row in kt.rows:
    row.height = Inches(0.27)
keys_s.shapes[2].top = Inches(2.42)
paint_table(kt, RGBColor(0xEC, 0xF1, 0xF3), RGBColor(0xFF, 0xFF, 0xFF))

# --------------------------------------------------------- language section
write(lang_s.shapes[0], [L("How to change languages", size=30)])
lt = lang_s.shapes[1].table
table_width(lt, [2.05, 6.95])
set_cell(lt.cell(0, 0), "Items", size=11, bold=True, align=PP_ALIGN.CENTER)
set_cell(lt.cell(0, 1), "Contents", size=11, bold=True, align=PP_ALIGN.CENTER)
set_cell(lt.cell(1, 0), "How to change languages", size=11, bold=True)
set_cell(lt.cell(1, 1),
         "Space IPTV 1.0 is a single-language app: all labels, messages and the PIN pad are in Portuguese (Brazil). "
         "There is no language selector inside the app and the TV OSD language does not change the app texts, "
         "so the tester does not need to change any setting to run the app.\n"
         "If a multi-language version is requested later, it will follow the TV language setting (Configurações → Geral → Idioma).",
         size=10.5)
paint_table(lt, RGBColor(0xEC, 0xF1, 0xF3), RGBColor(0xFF, 0xFF, 0xFF))
r2 = table_add_row(lt)
set_cell(r2.cells[0], "Country / region", size=11, bold=True)
set_cell(r2.cells[1],
         "The app runs in any country. The language of the content (channels, movies, series) comes from the playlist of the user, "
         "not from the app.", size=10.5)
# ------------------------------------------------------- test instructions
test_s = add_slide_like(prs, lang_s)
for sh in list(test_s.shapes):
    if sh.has_table:
        drop(sh)
write(test_s.shapes[0], [L("Test instructions", size=30)])
tb_test = test_s.shapes.add_textbox(Inches(0.5), Inches(2.05), Inches(9.0), Inches(4.9))
write(tb_test, [
    L("No login, no account, no payment: nothing has to be activated.", size=12.5, b=True),
    L("The app ships no content. To test it, add any playlist in Configurações → “+ Adicionar lista M3U (URL)” or "
      "“+ Adicionar Xtream Codes”.", size=12, space=8),
    L("Sample playlist for testing (public index of free-to-air channels, not bundled with the app):", size=12, space=8),
    L("https://iptv-org.github.io/iptv/countries/br.m3u   — about 90 channels, 85 KB.", size=12, b=True, color=TEAL, indent=228600),
    L("Internet is required to download the playlist and to play the streams. The catalog is stored on the device, so the "
      "second launch opens instantly.", size=12, space=8),
    L("First launch without any list opens Configurações automatically — that is the expected behaviour, not an error.", size=12, space=8),
    L("Channel health: open TV ao vivo and wait ~3 s; the dots appear on the visible channels (green / yellow / orange / red / gray). "
      "INFO explains the colour of the focused channel.", size=12, space=8),
    L("Parental control: Configurações → Controle parental → “Definir senha” (4 digits, typed on the pad). Test the lock on / off and the "
      "“Liberar conteúdo adulto agora” option.", size=12, space=8),
    L("A channel that does not play is a provider issue (expired URL or geo-blocked stream), not an app error: the player shows the reason "
      "and offers “Tentar novamente”.", size=12, space=8),
    L("Seller contact: Pedro Paulo Franco", size=12, space=10, color=GREY),
])

for shp in (scen_s.shapes[1], s9.shapes[1], tb_test):
    hang_numbers(shp)

# ------------------------------------------------------------------- order
order = [title_s, rev_s, toc_s, ui_s, flow_s, layers_s, scen_s, s9] + menu_slides + [keys_s, lang_s, test_s]
for i, s in enumerate(order):
    move_slide(prs, s, i)

# remove the guidance page and the depth-navigation sample
delete_slide(prs, guide_s)
delete_slide(prs, depth_s)
prs.save(OUT)
print("saved", OUT, "slides:", len(prs.slides))
