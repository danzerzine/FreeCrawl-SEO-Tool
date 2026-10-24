"""Give the latin audit-report font subsets a glyph for U+202F (narrow no-break space).

The @fontsource latin subsets of Literata and Golos Text claim U+2000-206F in their
unicode-range but carry no U+202F glyph, so browsers draw the Russian thousands
separator from a fallback font and some numbers lose the gap. This maps U+202F to
the font's own thin-space glyph (U+2009), which has the intended width.
Modification is allowed by the SIL OFL 1.1 (no Reserved Font Name is declared).

Run once after replacing the font files (needs fontTools and brotli), then
node packages/core/scripts/gen-audit-fonts.mjs
"""

import sys
from pathlib import Path

from fontTools.ttLib import TTFont

NNBSP, THIN = 0x202F, 0x2009
assets = Path(__file__).resolve().parent.parent / "assets" / "audit-fonts"
for path in sorted(assets.glob("*-latin-*.woff2")):
    font = TTFont(path)
    best = font.getBestCmap()
    if NNBSP in best:
        print(f"{path.name}: has U+202F")
        continue
    glyph = best.get(THIN)
    if glyph is None:
        sys.exit(f"{path.name}: no U+2009 glyph to map U+202F to")
    for table in font["cmap"].tables:
        if table.isUnicode():
            table.cmap[NNBSP] = glyph
    font.flavor = "woff2"
    font.save(path)
    print(f"{path.name}: U+202F -> {glyph}")
