import { describe, expect, it } from 'vitest';
import {
  PdfFindState,
  findStatusText,
  fitZoomLabel,
  flattenPdfOutline,
  isFitZoom,
  isPdfPath,
  parsePageInput,
  zoomPercentLabel,
} from '../pdf';

describe('isPdfPath', () => {
  it('matches .pdf in any case and nothing else', () => {
    expect(isPdfPath('/docs/spec.pdf')).toBe(true);
    expect(isPdfPath('C:\\Docs\\Spec.PDF')).toBe(true);
    expect(isPdfPath('/docs/spec.pdf.md')).toBe(false);
    expect(isPdfPath('/docs/report.docx')).toBe(false);
    expect(isPdfPath('/docs/pdf')).toBe(false);
  });
});

describe('parsePageInput', () => {
  it('accepts a whole page number inside the document', () => {
    expect(parsePageInput('3', 12)).toBe(3);
    expect(parsePageInput(' 12 ', 12)).toBe(12);
    expect(parsePageInput('1', 1)).toBe(1);
  });

  it('rejects anything that is not a page of this document', () => {
    expect(parsePageInput('0', 12)).toBeNull();
    expect(parsePageInput('13', 12)).toBeNull();
    expect(parsePageInput('-1', 12)).toBeNull();
    expect(parsePageInput('2.5', 12)).toBeNull();
    expect(parsePageInput('', 12)).toBeNull();
    expect(parsePageInput('two', 12)).toBeNull();
    expect(parsePageInput('1', 0)).toBeNull();
  });
});

describe('zoom labels', () => {
  it('knows the fitted zooms pdf.js understands', () => {
    expect(isFitZoom('auto')).toBe(true);
    expect(isFitZoom('page-width')).toBe(true);
    expect(isFitZoom('1.5')).toBe(false);
    expect(fitZoomLabel('page-fit')).toBe('Fit page');
  });

  it('rounds the scale to a whole percent', () => {
    expect(zoomPercentLabel(1)).toBe('100%');
    expect(zoomPercentLabel(1.2549)).toBe('125%');
    expect(zoomPercentLabel(0.333)).toBe('33%');
  });
});

describe('flattenPdfOutline', () => {
  it('walks the bookmark tree depth-first with 1-based levels', () => {
    const out = flattenPdfOutline([
      {
        title: 'Intro',
        dest: 'intro',
        items: [
          { title: 'Scope', dest: [{ num: 4 }, { name: 'XYZ' }] },
          { title: 'Terms', dest: null, items: [{ title: 'Deep', dest: 'deep' }] },
        ],
      },
      { title: 'Website', url: 'https://example.com' },
    ]);
    expect(out.map((e) => [e.title, e.level])).toEqual([
      ['Intro', 1],
      ['Scope', 2],
      ['Terms', 2],
      ['Deep', 3],
      ['Website', 1],
    ]);
    expect(out[0]?.dest).toBe('intro');
    expect(out[2]?.dest).toBeNull();
    expect(out[4]?.url).toBe('https://example.com');
    expect(out[4]?.dest).toBeNull();
  });

  it('collapses whitespace in titles and caps the depth', () => {
    const deep = { title: 'L4', items: [{ title: 'L5' }] };
    const out = flattenPdfOutline(
      [
        {
          title: '  Two\n lines\t here ',
          items: [{ title: 'L2', items: [{ title: 'L3', items: [deep] }] }],
        },
      ],
      3,
    );
    expect(out[0]?.title).toBe('Two lines here');
    expect(out.map((e) => e.level)).toEqual([1, 2, 3, 3, 3]);
  });

  it('treats a missing outline as empty', () => {
    expect(flattenPdfOutline(null)).toEqual([]);
    expect(flattenPdfOutline(undefined)).toEqual([]);
  });
});

describe('findStatusText', () => {
  it('says nothing without a query or a search', () => {
    expect(findStatusText('', PdfFindState.FOUND, 1, 3)).toBe('');
    expect(findStatusText('cat', null, 0, 0)).toBe('');
  });

  it('reports progress, results and misses', () => {
    expect(findStatusText('cat', PdfFindState.PENDING, 0, 0)).toBe('Searching…');
    expect(findStatusText('cat', PdfFindState.PENDING, 1, 4)).toBe('1 of 4');
    expect(findStatusText('cat', PdfFindState.FOUND, 2, 4)).toBe('2 of 4');
    expect(findStatusText('cat', PdfFindState.WRAPPED, 1, 4)).toBe('1 of 4');
    expect(findStatusText('cat', PdfFindState.NOT_FOUND, 0, 0)).toBe('No matches');
  });
});
