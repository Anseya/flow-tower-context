# -*- coding: utf-8 -*-
"""Render the preview PDF to PNG pages so the layout can be eyeballed."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__)))), ".tools", "py"))
import pymupdf  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PDF = os.path.join(ROOT, "paper", "preview", "paper.pdf")
OUT = os.path.join(ROOT, "paper", "preview")


def main():
    doc = pymupdf.open(PDF)
    print("pages", doc.page_count)
    for index, page in enumerate(doc):
        pix = page.get_pixmap(dpi=110)
        name = os.path.join(OUT, f"page-{index + 1:02d}.png")
        pix.save(name)
    print("rendered", doc.page_count, "pages to", OUT)


if __name__ == "__main__":
    main()
