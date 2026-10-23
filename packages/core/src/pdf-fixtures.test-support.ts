import { PDFDocument, PDFName, PDFString, StandardFonts, type PDFArray } from 'pdf-lib';

/**
 * PDFs for the B42 tests, written with pdf-lib so no binary sits in the
 * repository (the Cyrillic and the password-protected ones are the exception:
 * pdf-lib's standard fonts cannot write Cyrillic and it cannot encrypt).
 */

/** One page per entry of `pages`; `links` are URI link annotations on the given 1-based page. */
export async function makePdf(
  pages: string[],
  links: { page: number; url: string }[] = [],
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  pages.forEach((text, i) => {
    const page = doc.addPage([300, 200]);
    page.drawText(text, { x: 20, y: 100, size: 14, font });
    const annots = links.filter((l) => l.page === i + 1);
    if (annots.length === 0) return;
    const refs = annots.map((l, k) =>
      doc.context.register(
        doc.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [20, 90 - k * 20, 120, 110 - k * 20],
          Border: [0, 0, 0],
          A: { Type: 'Action', S: 'URI', URI: PDFString.of(l.url) },
        }),
      ),
    );
    page.node.set(PDFName.of('Annots'), doc.context.obj(refs) as PDFArray);
  });
  return doc.save({ useObjectStreams: true });
}
