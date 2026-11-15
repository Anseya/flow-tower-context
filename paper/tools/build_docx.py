# -*- coding: utf-8 -*-
"""Build the GB/T-style paper DOCX from content.py and the generated figures."""
import os
import re

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_TAB_ALIGNMENT, WD_LINE_SPACING
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

import content

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FIG_DIR = os.path.join(ROOT, "paper", "figures")
OUT_DIR = os.path.join(ROOT, "paper")
OUTPUT = os.path.join(OUT_DIR, "FlowTower-压缩驱动的项目级上下文记忆系统.docx")

TEXT_WIDTH_CM = 15.8
BODY_FONT = "宋体"
BODY_EN = "Times New Roman"
HEAD_FONT = "黑体"
AUTHOR_FONT = "楷体"

FIG_WIDTH = {
    "fig1_architecture": 15.6,
    "fig2_sequence": 15.6,
    "fig3_policy": 15.4,
    "fig4_recall": 14.4,
    "fig5_cost": 14.4,
    "fig6_budget_surface_3d": 11.6,
}


def set_run(run, size=10.5, bold=False, cn=BODY_FONT, en=BODY_EN, italic=False, color=None):
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.italic = italic
    run.font.name = en
    rpr = run._element.get_or_add_rPr()
    fonts = rpr.find(qn("w:rFonts"))
    if fonts is None:
        fonts = OxmlElement("w:rFonts")
        rpr.append(fonts)
    fonts.set(qn("w:ascii"), en)
    fonts.set(qn("w:hAnsi"), en)
    fonts.set(qn("w:eastAsia"), cn)
    if color is not None:
        run.font.color.rgb = color
    return run


def add_text(par, text, size=10.5, bold=False, cn=BODY_FONT, en=BODY_EN, italic=False):
    """Append text, converting ⟦1,2⟧ markers into superscript [1,2]."""
    pattern = re.compile(r"⟦([^⟧]+)⟧")
    pos = 0
    for match in pattern.finditer(text):
        if match.start() > pos:
            set_run(par.add_run(text[pos:match.start()]), size, bold, cn, en, italic)
        run = par.add_run(f"[{match.group(1)}]")
        set_run(run, size, bold, cn, en, italic)
        run.font.superscript = True
        pos = match.end()
    if pos < len(text):
        set_run(par.add_run(text[pos:]), size, bold, cn, en, italic)


def add_body_par(doc, text):
    par = doc.add_paragraph()
    par.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    fmt = par.paragraph_format
    fmt.first_line_indent = Pt(21)
    fmt.line_spacing = 1.3
    fmt.space_before = Pt(0)
    fmt.space_after = Pt(0)
    add_text(par, text)
    return par


def add_heading(doc, text, level):
    par = doc.add_paragraph()
    par.alignment = WD_ALIGN_PARAGRAPH.LEFT
    fmt = par.paragraph_format
    if level == 1:
        fmt.space_before = Pt(13)
        fmt.space_after = Pt(6)
        size = 14
    else:
        fmt.space_before = Pt(9)
        fmt.space_after = Pt(4)
        size = 12
    fmt.line_spacing = 1.15
    add_text(par, text, size=size, bold=True, cn=HEAD_FONT, en=HEAD_FONT)
    return par


def add_caption(doc, text, before=4, after=8, keep_next=False):
    par = doc.add_paragraph()
    par.alignment = WD_ALIGN_PARAGRAPH.CENTER
    fmt = par.paragraph_format
    fmt.space_before = Pt(before)
    fmt.space_after = Pt(after)
    fmt.line_spacing = 1.0
    if keep_next:
        fmt.keep_with_next = True
    add_text(par, text, size=9, bold=True, cn=HEAD_FONT, en=HEAD_FONT)
    return par


def add_figure(doc, name, caption):
    path = os.path.join(FIG_DIR, f"{name}.png")
    par = doc.add_paragraph()
    par.alignment = WD_ALIGN_PARAGRAPH.CENTER
    par.paragraph_format.space_before = Pt(8)
    par.paragraph_format.space_after = Pt(0)
    run = par.add_run()
    run.add_picture(path, width=Cm(FIG_WIDTH.get(name, 15.0)))
    add_caption(doc, caption, before=4, after=10)


def set_cell_border(cell, edge, sz=8):
    tc_pr = cell._tc.get_or_add_tcPr()
    borders = tc_pr.find(qn("w:tcBorders"))
    if borders is None:
        borders = OxmlElement("w:tcBorders")
        tc_pr.append(borders)
    element = borders.find(qn(f"w:{edge}"))
    if element is None:
        element = OxmlElement(f"w:{edge}")
        borders.append(element)
    element.set(qn("w:val"), "single")
    element.set(qn("w:sz"), str(sz))
    element.set(qn("w:space"), "0")
    element.set(qn("w:color"), "000000")


def set_table_borders(table):
    tbl_pr = table._tbl.tblPr
    borders = OxmlElement("w:tblBorders")
    for edge, sz in (("top", 12), ("bottom", 12)):
        element = OxmlElement(f"w:{edge}")
        element.set(qn("w:val"), "single")
        element.set(qn("w:sz"), str(sz))
        element.set(qn("w:space"), "0")
        element.set(qn("w:color"), "000000")
        borders.append(element)
    for edge in ("left", "right", "insideH", "insideV"):
        element = OxmlElement(f"w:{edge}")
        element.set(qn("w:val"), "none")
        element.set(qn("w:sz"), "0")
        element.set(qn("w:space"), "0")
        element.set(qn("w:color"), "auto")
        borders.append(element)
    tbl_pr.append(borders)


def set_cell_margins(table):
    tbl_pr = table._tbl.tblPr
    mar = OxmlElement("w:tblCellMar")
    for edge, width in (("top", 20), ("bottom", 20), ("left", 60), ("right", 60)):
        element = OxmlElement(f"w:{edge}")
        element.set(qn("w:w"), str(width))
        element.set(qn("w:type"), "dxa")
        mar.append(element)
    tbl_pr.append(mar)


def add_table(doc, table_id):
    spec = content.TABLES[table_id]
    add_caption(doc, spec["caption"], before=9, after=3, keep_next=True)
    rows = [spec["head"]] + spec["rows"]
    table = doc.add_table(rows=len(rows), cols=len(spec["head"]))
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    set_table_borders(table)
    set_cell_margins(table)
    widths = spec["widths"]
    scale = TEXT_WIDTH_CM / sum(widths)
    widths = [w * scale for w in widths]
    for col_index, width in enumerate(widths):
        for cell in table.columns[col_index].cells:
            cell.width = Cm(width)
    for row_index, row in enumerate(rows):
        for col_index, value in enumerate(row):
            cell = table.cell(row_index, col_index)
            par = cell.paragraphs[0]
            par.paragraph_format.space_before = Pt(2)
            par.paragraph_format.space_after = Pt(2)
            par.paragraph_format.line_spacing = 1.0
            par.alignment = (WD_ALIGN_PARAGRAPH.LEFT if widths[col_index] >= 3.4
                             else WD_ALIGN_PARAGRAPH.CENTER)
            add_text(par, value, size=9, bold=(row_index == 0))
    for cell in table.rows[0].cells:
        set_cell_border(cell, "bottom", sz=6)
    for cell in table.rows[0].cells:
        set_cell_border(cell, "top", sz=12)
    for cell in table.rows[-1].cells:
        set_cell_border(cell, "bottom", sz=12)

    # Repeat the header when the table breaks across pages, and never split a row.
    tr_pr = table.rows[0]._tr.get_or_add_trPr()
    header = OxmlElement("w:tblHeader")
    header.set(qn("w:val"), "true")
    tr_pr.append(header)
    for row in table.rows:
        row_pr = row._tr.get_or_add_trPr()
        row_pr.append(OxmlElement("w:cantSplit"))

    spacer = doc.add_paragraph()
    spacer.paragraph_format.space_before = Pt(0)
    spacer.paragraph_format.space_after = Pt(0)
    spacer.paragraph_format.line_spacing = 1.0
    set_run(spacer.add_run(""), 6)


def add_url_block(doc, url):
    par = doc.add_paragraph()
    par.alignment = WD_ALIGN_PARAGRAPH.CENTER
    par.paragraph_format.space_before = Pt(4)
    par.paragraph_format.space_after = Pt(8)
    par.paragraph_format.line_spacing = 1.0
    run = par.add_run(url)
    set_run(run, 11, bold=True, cn=BODY_FONT, en="Consolas")
    run.font.color.rgb = RGBColor(0x1F, 0x4E, 0x79)
    return par


def add_code_block(doc, text):
    par = doc.add_paragraph()
    par.alignment = WD_ALIGN_PARAGRAPH.LEFT
    fmt = par.paragraph_format
    fmt.left_indent = Cm(0.3)
    fmt.space_before = Pt(6)
    fmt.space_after = Pt(8)
    fmt.line_spacing = 1.15
    p_pr = par._p.get_or_add_pPr()
    shading = OxmlElement("w:shd")
    shading.set(qn("w:val"), "clear")
    shading.set(qn("w:color"), "auto")
    shading.set(qn("w:fill"), "F4F5F7")
    p_pr.append(shading)
    for index, line in enumerate(text.split("\n")):
        if index > 0:
            par.add_run().add_break()
        set_run(par.add_run(line), 8.5, False, BODY_FONT, "Consolas")
    return par


def add_equation(doc, markup, number):
    """Formula in a borderless 1x2 table: centered formula + right-aligned number."""
    table = doc.add_table(rows=1, cols=2)
    table.autofit = False
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    tbl_pr = table._tbl.tblPr
    borders = OxmlElement("w:tblBorders")
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        element = OxmlElement(f"w:{edge}")
        element.set(qn("w:val"), "none")
        element.set(qn("w:sz"), "0")
        element.set(qn("w:space"), "0")
        borders.append(element)
    tbl_pr.append(borders)
    margins = OxmlElement("w:tblCellMar")
    for edge in ("top", "bottom", "left", "right"):
        element = OxmlElement(f"w:{edge}")
        element.set(qn("w:w"), "0")
        element.set(qn("w:type"), "dxa")
        margins.append(element)
    tbl_pr.append(margins)
    table.cell(0, 0).width = Cm(TEXT_WIDTH_CM - 1.6)
    table.cell(0, 1).width = Cm(1.6)

    left = table.cell(0, 0).paragraphs[0]
    left.alignment = WD_ALIGN_PARAGRAPH.CENTER
    left.paragraph_format.space_before = Pt(5)
    left.paragraph_format.space_after = Pt(5)
    left.paragraph_format.line_spacing = 1.0
    pattern = re.compile(r"_(?:\{([^}]*)\}|(\w))")
    pos = 0
    for match in pattern.finditer(markup):
        if match.start() > pos:
            set_run(left.add_run(markup[pos:match.start()]), 10.5, False, BODY_FONT, "Cambria Math")
        sub = match.group(1) if match.group(1) is not None else match.group(2)
        run = left.add_run(sub)
        set_run(run, 10.5, False, BODY_FONT, "Cambria Math")
        run.font.subscript = True
        pos = match.end()
    if pos < len(markup):
        set_run(left.add_run(markup[pos:]), 10.5, False, BODY_FONT, "Cambria Math")

    right = table.cell(0, 1).paragraphs[0]
    right.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    right.paragraph_format.space_before = Pt(5)
    right.paragraph_format.space_after = Pt(5)
    set_run(right.add_run(f"({number})"), 10.5)


def add_page_number_footer(section):
    footer = section.footer
    par = footer.paragraphs[0]
    par.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = par.add_run("— ")
    set_run(run, 9)
    field = OxmlElement("w:fldSimple")
    field.set(qn("w:instr"), "PAGE")
    run_element = OxmlElement("w:r")
    text = OxmlElement("w:t")
    text.text = "1"
    run_element.append(text)
    field.append(run_element)
    par._p.append(field)
    run2 = par.add_run(" —")
    set_run(run2, 9)


def build():
    doc = Document()
    section = doc.sections[0]
    section.page_width = Cm(21.0)
    section.page_height = Cm(29.7)
    section.top_margin = Cm(2.54)
    section.bottom_margin = Cm(2.54)
    section.left_margin = Cm(2.6)
    section.right_margin = Cm(2.6)
    add_page_number_footer(section)

    core = doc.core_properties
    core.title = content.META["title_cn"]
    core.author = content.META["authors_cn"].replace("　", " ")
    core.subject = "上下文工程 / 智能体记忆系统"

    normal = doc.styles["Normal"]
    normal.font.name = BODY_EN
    normal.font.size = Pt(10.5)
    normal.element.rPr.rFonts.set(qn("w:eastAsia"), BODY_FONT)

    meta = content.META

    def add_multiline(par, text, size, bold=False, cn=BODY_FONT, en=BODY_EN):
        for index, line in enumerate(text.split("\n")):
            if index > 0:
                par.add_run().add_break()
            add_text(par, line, size=size, bold=bold, cn=cn, en=en)

    # ---- Chinese title block
    par = doc.add_paragraph()
    par.alignment = WD_ALIGN_PARAGRAPH.CENTER
    par.paragraph_format.space_before = Pt(0)
    par.paragraph_format.space_after = Pt(14)
    add_multiline(par, meta["title_cn"], 22, bold=True, cn=HEAD_FONT, en=HEAD_FONT)

    par = doc.add_paragraph()
    par.alignment = WD_ALIGN_PARAGRAPH.CENTER
    par.paragraph_format.space_after = Pt(4)
    if meta["authors_cn"]:
        add_text(par, meta["authors_cn"], size=12, cn=AUTHOR_FONT, en=AUTHOR_FONT)
    else:
        par.paragraph_format.space_after = Pt(0)

    if meta["affiliation_cn"]:
        par = doc.add_paragraph()
        par.alignment = WD_ALIGN_PARAGRAPH.CENTER
        par.paragraph_format.space_after = Pt(10)
        add_text(par, meta["affiliation_cn"], size=9)

    def label_par(label, text, size=10.5):
        par = doc.add_paragraph()
        par.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        fmt = par.paragraph_format
        fmt.first_line_indent = Pt(21)
        fmt.line_spacing = 1.25
        fmt.space_before = Pt(2)
        fmt.space_after = Pt(2)
        add_text(par, label, size=size, bold=True, cn=HEAD_FONT, en=HEAD_FONT)
        add_text(par, text, size=size)
        return par

    label_par("摘要：", meta["abstract_cn"])
    label_par("关键词：", meta["keywords_cn"])

    # ---- English block
    par = doc.add_paragraph()
    par.alignment = WD_ALIGN_PARAGRAPH.CENTER
    par.paragraph_format.space_before = Pt(14)
    par.paragraph_format.space_after = Pt(8)
    add_multiline(par, meta["title_en"], 16, bold=True, cn=HEAD_FONT, en=HEAD_FONT)

    if meta["authors_en"]:
        par = doc.add_paragraph()
        par.alignment = WD_ALIGN_PARAGRAPH.CENTER
        par.paragraph_format.space_after = Pt(3)
        add_text(par, meta["authors_en"], size=11)

    if meta["affiliation_en"]:
        par = doc.add_paragraph()
        par.alignment = WD_ALIGN_PARAGRAPH.CENTER
        par.paragraph_format.space_after = Pt(8)
        add_text(par, meta["affiliation_en"], size=9)

    par = doc.add_paragraph()
    par.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    par.paragraph_format.first_line_indent = Pt(18)
    par.paragraph_format.line_spacing = 1.2
    par.paragraph_format.space_after = Pt(2)
    add_text(par, "Abstract: ", size=10, bold=True)
    add_text(par, meta["abstract_en"], size=10)

    par = doc.add_paragraph()
    par.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    par.paragraph_format.line_spacing = 1.2
    par.paragraph_format.space_after = Pt(6)
    add_text(par, "Keywords: ", size=10, bold=True)
    add_text(par, meta["keywords_en"], size=10)

    # ---- body
    for block in content.BODY:
        kind = block[0]
        if kind == "h1":
            add_heading(doc, block[1], 1)
        elif kind == "h2":
            add_heading(doc, block[1], 2)
        elif kind == "p":
            add_body_par(doc, block[1])
        elif kind == "fig":
            add_figure(doc, block[1], block[2])
        elif kind == "table":
            add_table(doc, block[1])
        elif kind == "code":
            add_code_block(doc, block[1])
        elif kind == "url":
            add_url_block(doc, block[1])
        elif kind == "eq":
            add_equation(doc, block[1], block[2])
        else:
            raise ValueError(f"unknown block {kind}")

    # ---- references
    add_heading(doc, "参考文献", 1)
    for index, ref in enumerate(content.REFERENCES, start=1):
        par = doc.add_paragraph()
        par.alignment = WD_ALIGN_PARAGRAPH.LEFT
        fmt = par.paragraph_format
        fmt.left_indent = Pt(24)
        fmt.first_line_indent = Pt(-24)
        fmt.line_spacing = 1.15
        fmt.space_before = Pt(1)
        fmt.space_after = Pt(1)
        add_text(par, f"[{index}]　{ref}", size=9)

    doc.save(OUTPUT)
    print("saved", OUTPUT)


if __name__ == "__main__":
    build()
