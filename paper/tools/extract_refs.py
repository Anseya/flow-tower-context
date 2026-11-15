# -*- coding: utf-8 -*-
"""Print the first page of every PDF under papers/ so the paper can cite real metadata."""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, ".tools", "py"))

from pypdf import PdfReader  # noqa: E402

def main():
    base = os.path.join(ROOT, "papers")
    for dirpath, _dirnames, filenames in os.walk(base):
        for name in sorted(filenames):
            if not name.lower().endswith(".pdf"):
                continue
            path = os.path.join(dirpath, name)
            print("=" * 90)
            print(name)
            try:
                reader = PdfReader(path)
                text = (reader.pages[0].extract_text() or "").replace("\n", " ")
                print(text[:900])
            except Exception as error:  # noqa: BLE001
                print("ERROR", error)


if __name__ == "__main__":
    main()
