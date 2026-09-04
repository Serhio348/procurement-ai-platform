"""Convert one PDF page with the sibling mcp-pdf-reader Docling pipeline."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

READER = Path(r"E:\Projects\mcp-pdf-reader")
if not READER.exists():
    raise SystemExit(f"mcp-pdf-reader not found at {READER}")

sys.path.insert(0, str(READER))

import pypdfium2 as pdfium  # noqa: E402
from pdf_converter import convert_with_mode  # noqa: E402


def slice_page(src: Path, page_number: int, dest: Path) -> None:
    source = pdfium.PdfDocument(str(src))
    try:
        if page_number < 1 or page_number > len(source):
            raise SystemExit(f"page {page_number} is out of range (1..{len(source)})")
        sliced = pdfium.PdfDocument.new()
        sliced.import_pages(source, [page_number - 1])
        dest.parent.mkdir(parents=True, exist_ok=True)
        sliced.save(str(dest))
        sliced.close()
    finally:
        source.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Docling OCR for a single PDF page.")
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--page", type=int, default=1)
    parser.add_argument("--mode", choices=["fast", "full", "auto"], default="full")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    if not args.pdf.exists():
        raise SystemExit(f"PDF not found: {args.pdf}")

    one_page = args.output.with_suffix(".page.pdf")
    slice_page(args.pdf, args.page, one_page)
    markdown = convert_with_mode(one_page, args.mode)
    args.output.write_text(markdown, encoding="utf-8")


if __name__ == "__main__":
    main()
