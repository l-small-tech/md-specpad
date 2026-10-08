/**
 * markdown → PDF converter tests. Most assertions run against the pdfmake
 * document DEFINITION (`markdownToPdfDocDef`) — pure data, no pdfmake in the
 * loop. A few round-trips generate a real PDF via `markdownToPdfBase64` and
 * read it back with pdfjs (the same library the app's PDF importer uses) to
 * prove the output is a valid document with the expected text.
 */
import { describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_PDF_THEME,
  markdownToPdfBase64,
  markdownToPdfDocDef,
  monoFont,
  pdfImageType,
  pdfDocDefToBase64,
  pdfThemeFromPlugin,
  type PdfDocDef,
  type PdfRun,
} from '../pdf';
import type { ThemePlugin } from '../../theme-plugins';

/** 1×1 red PNG. */
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TINY_PNG_URL = `data:image/png;base64,${TINY_PNG}`;

/** Flatten every text run in a docdef content tree (depth-first). */
function collectRuns(node: unknown, out: PdfRun[] = []): PdfRun[] {
  if (Array.isArray(node)) {
    for (const child of node) {
      collectRuns(child, out);
    }
    return out;
  }
  if (typeof node === 'string') {
    out.push({ text: node });
    return out;
  }
  if (typeof node === 'object' && node !== null) {
    const rec = node as Record<string, unknown>;
    if (typeof rec.text === 'string') {
      out.push(rec as unknown as PdfRun);
    }
    for (const key of ['text', 'content', 'stack', 'ul', 'ol', 'table', 'body', 'columns']) {
      if (key in rec && typeof rec[key] === 'object') {
        collectRuns(rec[key], out);
      }
    }
    return out;
  }
  return out;
}

function fullText(node: unknown): string {
  return collectRuns(node)
    .map((r) => r.text)
    .join('');
}

describe('pdfImageType', () => {
  test('maps png/jpg extensions and rejects the rest', () => {
    expect(pdfImageType('a.png')).toBe('png');
    expect(pdfImageType('A.JPG')).toBe('jpg');
    expect(pdfImageType('b.jpeg')).toBe('jpg');
    expect(pdfImageType('c.gif')).toBeNull();
    expect(pdfImageType('d.webp')).toBeNull();
    expect(pdfImageType('e.svg')).toBeNull();
    expect(pdfImageType('f.bmp')).toBeNull();
  });
});

describe('monoFont', () => {
  test('routes WinAnsi-safe text to Courier, everything else to Roboto', () => {
    expect(monoFont('const x = 1;')).toBe('Courier');
    expect(monoFont('naïve café — “quoted”…')).toBe('Courier');
    expect(monoFont('你好')).toBe('Roboto');
    expect(monoFont('emoji 🎉')).toBe('Roboto');
    expect(monoFont('')).toBe('Courier');
  });
});

describe('pdfThemeFromPlugin', () => {
  const plugin: ThemePlugin = {
    id: 'test',
    name: 'Test',
    mode: 'light',
    branding: {
      editorBg: '#fefefe',
      fg: '#111111',
      accent: '#ff0000',
      bgAlt: '#eeeeee',
      border: '#dddddd',
      fgMuted: '#777777',
    },
    syntax: { heading: '#222222', heading2: '#333333', link: '#0000ff', code: '#005500' },
  };

  test('null plugin returns the neutral default', () => {
    expect(pdfThemeFromPlugin(null)).toEqual(DEFAULT_PDF_THEME);
  });

  test('maps branding + syntax with CSS-matching fallback chains', () => {
    const theme = pdfThemeFromPlugin(plugin);
    expect(theme.pageBg).toBe('#fefefe');
    expect(theme.fg).toBe('#111111');
    expect(theme.headings[0]).toBe('#222222'); // heading base
    expect(theme.headings[1]).toBe('#333333'); // per-level override
    expect(theme.headings[5]).toBe('#222222'); // falls back to heading base
    expect(theme.link).toBe('#0000ff'); // syntax.link beats branding.accent
    expect(theme.codeFg).toBe('#005500');
    expect(theme.codeBg).toBe('#eeeeee');
    expect(theme.border).toBe('#dddddd');
    expect(theme.muted).toBe('#777777');
  });

  test('non-hex values fall back to the slot default', () => {
    const theme = pdfThemeFromPlugin({
      ...plugin,
      branding: { fg: 'rgb(20, 20, 20)' },
      syntax: undefined,
    });
    // fg is rgb(...) — not hex — so the default fg applies.
    expect(theme.fg).toBe(DEFAULT_PDF_THEME.fg);
    expect(theme.pageBg).toBe(DEFAULT_PDF_THEME.pageBg);
  });
});

describe('markdownToPdfDocDef', () => {
  test('headings get level sizes and theme colors', async () => {
    const def = await markdownToPdfDocDef('# One\n\n## Two', {
      theme: { ...DEFAULT_PDF_THEME, headings: ['#100000', '#200000', '#3', '#4', '#5', '#6'] },
    });
    const [h1, h2] = def.content as [Record<string, unknown>, Record<string, unknown>];
    expect(h1.fontSize).toBe(24);
    expect(h1.color).toBe('#100000');
    expect(h2.fontSize).toBe(20);
    expect(h2.color).toBe('#200000');
    expect(fullText(h1)).toBe('One');
  });

  test('inline styles nest (bold+italic, strikethrough)', async () => {
    const def = await markdownToPdfDocDef('**bold _both_** and ~~gone~~');
    const runs = collectRuns(def.content);
    const both = runs.find((r) => r.text === 'both');
    expect(both?.bold).toBe(true);
    expect(both?.italics).toBe(true);
    const gone = runs.find((r) => r.text === 'gone');
    expect(gone?.decoration).toBe('lineThrough');
  });

  test('links carry url, underline and theme color; reference links resolve', async () => {
    const def = await markdownToPdfDocDef(
      '[a](https://a.example) and [b][ref]\n\n[ref]: https://b.example',
    );
    const runs = collectRuns(def.content);
    const a = runs.find((r) => r.text === 'a');
    expect(a?.link).toBe('https://a.example');
    expect(a?.decoration).toBe('underline');
    expect(a?.color).toBe(DEFAULT_PDF_THEME.link);
    const b = runs.find((r) => r.text === 'b');
    expect(b?.link).toBe('https://b.example');
  });

  test('inline code is shaded and mono, with WinAnsi fallback to Roboto', async () => {
    const def = await markdownToPdfDocDef('`safe()` and `你好`');
    const runs = collectRuns(def.content);
    const safe = runs.find((r) => r.text === 'safe()');
    expect(safe?.font).toBe('Courier');
    expect(safe?.background).toBe(DEFAULT_PDF_THEME.codeBg);
    const cjk = runs.find((r) => r.text === '你好');
    expect(cjk?.font).toBe('Roboto');
  });

  test('code blocks become a filled one-cell table of mono lines', async () => {
    const def = await markdownToPdfDocDef('```\nline one\n  indented\n```');
    const block = (def.content as Record<string, unknown>[]).find((b) => 'table' in b)!;
    const table = block.table as { body: { stack: PdfRun[]; fillColor: string }[][] };
    const cell = table.body[0]![0]!;
    expect(cell.fillColor).toBe(DEFAULT_PDF_THEME.codeBg);
    const lines = cell.stack as unknown as Record<string, unknown>[];
    expect(lines.map((l) => l.text)).toEqual(['line one', '  indented']);
    expect(lines[1]!.preserveLeadingSpaces).toBe(true);
    expect(lines[0]!.font).toBe('Courier');
  });

  test('lists: unordered, ordered with start, task markers, nesting', async () => {
    const def = await markdownToPdfDocDef(
      ['- a', '- b', '  - b1', '', '3. three', '4. four', '', '- [x] done', '- [ ] todo'].join(
        '\n',
      ),
    );
    const blocks = def.content as Record<string, unknown>[];
    const ul = blocks.find((b) => 'ul' in b)!;
    expect(fullText(ul)).toContain('a');
    expect(fullText(ul)).toContain('b1');
    const ol = blocks.find((b) => 'ol' in b)!;
    expect(ol.start).toBe(3);
    const tasks = blocks.filter((b) => 'ul' in b)[1]!;
    expect(fullText(tasks)).toContain('[x] done');
    expect(fullText(tasks)).toContain('[ ] todo');
  });

  test('tables get a header row with bold, filled cells and theme borders', async () => {
    const def = await markdownToPdfDocDef('| H1 | H2 |\n| --- | --- |\n| a | b |');
    const block = (def.content as Record<string, unknown>[]).find((b) => 'table' in b)!;
    const table = block.table as {
      headerRows: number;
      body: Record<string, unknown>[][];
    };
    expect(table.headerRows).toBe(1);
    expect(table.body).toHaveLength(2);
    const header = table.body[0]![0]!;
    expect(header.fillColor).toBe(DEFAULT_PDF_THEME.codeBg);
    const headerRuns = collectRuns(header);
    expect(headerRuns[0]?.bold).toBe(true);
    const layout = block.layout as { hLineColor: () => string };
    expect(layout.hLineColor()).toBe(DEFAULT_PDF_THEME.border);
  });

  test('table rows are squared to the header: short rows padded, extra cells dropped', async () => {
    // GFM lets body rows disagree with the header; pdfmake throws on a row
    // with a missing cell ("Malformed table row"). Same shape as the preview:
    // pad with empty cells, drop cells past the header's count.
    const def = await markdownToPdfDocDef(
      '| A | B | C |\n| - | - | - |\n| 1 | 2 |\n| x | y | z | extra |',
    );
    const block = (def.content as Record<string, unknown>[]).find((b) => 'table' in b)!;
    const table = block.table as { widths: unknown[]; body: Record<string, unknown>[][] };
    expect(table.widths).toHaveLength(3);
    expect(table.body.map((row) => row.length)).toEqual([3, 3, 3]);
    expect(table.body[1]![2]).toEqual({ text: ' ' });
    expect(fullText(table.body[2])).not.toContain('extra');
  });

  test('blockquotes draw only a left rule and contain their blocks', async () => {
    const def = await markdownToPdfDocDef('> quoted **text**');
    const block = (def.content as Record<string, unknown>[]).find((b) => 'table' in b)!;
    const layout = block.layout as {
      vLineWidth: (i: number) => number;
      hLineWidth: () => number;
      vLineColor: () => string;
    };
    expect(layout.vLineWidth(0)).toBe(3);
    expect(layout.vLineWidth(1)).toBe(0);
    expect(layout.hLineWidth()).toBe(0);
    expect(layout.vLineColor()).toBe(DEFAULT_PDF_THEME.muted);
    expect(fullText(block)).toContain('quoted ');
  });

  test('thematic break renders as a themed canvas line', async () => {
    const def = await markdownToPdfDocDef('a\n\n---\n\nb');
    const canvas = (def.content as Record<string, unknown>[]).find((b) => 'canvas' in b)!;
    const line = (canvas.canvas as Record<string, unknown>[])[0]!;
    expect(line.type).toBe('line');
    expect(line.lineColor).toBe(DEFAULT_PDF_THEME.border);
  });

  test('resolved images embed scaled; unresolved degrade to italic alt', async () => {
    const def = await markdownToPdfDocDef('![pic](img.png)\n\n![missing](gone.png)', {
      resolveImage: async (src) =>
        src === 'img.png' ? { dataUrl: TINY_PNG_URL, width: 1000, height: 500 } : null,
    });
    const blocks = def.content as Record<string, unknown>[];
    const image = blocks.find((b) => 'image' in b)!;
    expect(image.image).toBe(TINY_PNG_URL);
    expect(image.width).toBe(515); // 1000px × 0.75 capped to the content width
    const alt = collectRuns(blocks).find((r) => r.text === 'missing');
    expect(alt?.italics).toBe(true);
  });

  test('resolved SVGs embed as vector blocks, scaled like rasters', async () => {
    const svg = '<svg viewBox="0 0 800 400"><rect fill="#123456"/></svg>';
    const def = await markdownToPdfDocDef('![diagram](d.svg)', {
      resolveImage: async () => ({ svg, width: 800, height: 400 }),
    });
    const blocks = def.content as Record<string, unknown>[];
    const vector = blocks.find((b) => 'svg' in b)!;
    expect(vector.svg).toBe(svg);
    expect(vector.width).toBe(515); // 800px × 0.75 capped to the content width
    expect(blocks.some((b) => 'image' in b)).toBe(false);
  });

  test('footnotes render as superscript refs + in-place definitions', async () => {
    const def = await markdownToPdfDocDef('note[^1]\n\n[^1]: the detail');
    const runs = collectRuns(def.content);
    const ref = runs.find((r) => r.text === '[1]');
    expect(ref?.sup).toBe(true);
    expect(fullText(def.content)).toContain('[1] the detail');
  });

  test('raw HTML is dropped and gnarly input never rejects', async () => {
    const def = await markdownToPdfDocDef(
      '<div onclick="x()">boom</div>\n\ntext\n\n> > nested\n\n![w](a.webp)\n\nline  \nbreak',
    );
    expect(fullText(def.content)).not.toContain('boom');
    expect(fullText(def.content)).toContain('text');
  });

  test('page background layer appears only for non-white themes', async () => {
    const white = await markdownToPdfDocDef('x');
    expect(white.background).toBeUndefined();
    const dark = await markdownToPdfDocDef('x', {
      theme: { ...DEFAULT_PDF_THEME, pageBg: '#101010' },
    });
    const rect = (
      dark.background!(1, { width: 595, height: 842 }).canvas as Record<string, unknown>[]
    )[0]!;
    expect(rect.color).toBe('#101010');
    expect(rect.w).toBe(595);
  });
});

describe('pdfDocDefToBase64 failures', () => {
  // Regression: pdfmake's getBase64 swallows layout throws inside its own
  // promise chain, so a bad definition used to hang the export forever. No
  // pdfjs here — the failure happens in layout, before anything is rendered.
  test('rejects (quickly) when pdfmake throws during layout', async () => {
    const malformed = {
      content: [{ table: { body: [['a', 'b'], ['c']] } }],
    } as unknown as PdfDocDef;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(pdfDocDefToBase64(malformed)).rejects.toThrow(/Malformed table row/);
    } finally {
      consoleError.mockRestore();
    }
  }, 5000);
});

describe('markdownToPdfBase64 (round-trip)', () => {
  async function extractText(base64: string): Promise<string> {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = Uint8Array.from(Buffer.from(base64, 'base64'));
    const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
    let text = '';
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map((item) => ('str' in item ? item.str : '')).join(' ');
    }
    return text;
  }

  test('produces a valid PDF whose text is extractable', async () => {
    const base64 = await markdownToPdfBase64('# Title\n\nHello body text.');
    expect(Buffer.from(base64, 'base64').subarray(0, 5).toString()).toBe('%PDF-');
    const text = await extractText(base64);
    expect(text).toContain('Title');
    expect(text).toContain('Hello body text.');
  });

  test('code blocks (Courier) and tables survive generation', async () => {
    const base64 = await markdownToPdfBase64(
      '```\nconst x = 42;\n```\n\n| A | B |\n| - | - |\n| c1 | c2 |',
    );
    // pdfjs splits positioned runs; compare with whitespace collapsed away.
    const text = (await extractText(base64)).replaceAll(/\s+/g, '');
    expect(text).toContain('constx=42;');
    expect(text).toContain('c1');
  });

  test('a table with a short row generates instead of failing', async () => {
    // No pdfjs read-back: generation alone was what broke (pdfmake threw on
    // the missing cell and the promise never settled).
    const base64 = await markdownToPdfBase64('| A | B | C |\n| - | - | - |\n| 1 | 2 |');
    expect(Buffer.from(base64, 'base64').subarray(0, 5).toString()).toBe('%PDF-');
  }, 20_000);

  test('embeds a resolved PNG without failing', async () => {
    const base64 = await markdownToPdfBase64('![p](img.png)', {
      resolveImage: async () => ({ dataUrl: TINY_PNG_URL, width: 10, height: 10 }),
    });
    expect(Buffer.from(base64, 'base64').subarray(0, 5).toString()).toBe('%PDF-');
  });

  test('draws a resolved SVG as vector without failing', async () => {
    const base64 = await markdownToPdfBase64('![d](d.svg)', {
      resolveImage: async () => ({
        svg: '<svg viewBox="0 0 40 20"><rect width="40" height="20" fill="#334455"/><text x="2" y="14">svg</text></svg>',
        width: 40,
        height: 20,
      }),
    });
    expect(Buffer.from(base64, 'base64').subarray(0, 5).toString()).toBe('%PDF-');
    expect(await extractText(base64)).toContain('svg');
  });
});
