# -*- coding: utf-8 -*-
"""Dump the structure of a .pptx: slides, shapes, text, tables, images."""
import sys
from pptx import Presentation
from pptx.util import Emu

path = sys.argv[1]
prs = Presentation(path)
print("slide size: %.2f x %.2f in" % (prs.slide_width / 914400, prs.slide_height / 914400))
print("slides:", len(prs.slides))
for i, slide in enumerate(prs.slides, 1):
    print("\n=== SLIDE %d  (layout: %s) ===" % (i, slide.slide_layout.name))
    for sh in slide.shapes:
        kind = sh.shape_type
        pos = "(%.2f,%.2f %.2fx%.2f)" % (
            sh.left / 914400 if sh.left is not None else -1,
            sh.top / 914400 if sh.top is not None else -1,
            sh.width / 914400 if sh.width is not None else -1,
            sh.height / 914400 if sh.height is not None else -1,
        )
        print("  [%s] name=%r %s" % (kind, sh.name, pos))
        if sh.has_text_frame:
            for p in sh.text_frame.paragraphs:
                txt = "".join(r.text for r in p.runs)
                if txt.strip():
                    sizes = {r.font.size.pt if r.font.size else None for r in p.runs}
                    print("      P(lvl=%d, sz=%s): %r" % (p.level, sizes, txt))
        if sh.has_table:
            tbl = sh.table
            print("      TABLE %dx%d" % (len(tbl.rows), len(tbl.columns)))
            for r_i, row in enumerate(tbl.rows):
                cells = [c.text.replace("\n", "\\n") for c in row.cells]
                print("        r%d: %r" % (r_i, cells))
    if slide.has_notes_slide:
        nt = slide.notes_slide.notes_text_frame.text
        if nt.strip():
            print("  NOTES: %r" % nt)
