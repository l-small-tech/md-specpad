/**
 * markdownToDocxBase64 — structure and round-trip coverage. The strongest
 * check re-reads the generated .docx with mammoth (the app's own DOCX
 * importer): if mammoth can parse it back to the expected semantic HTML, real
 * Word processors can open it too.
 */
import { describe, expect, test } from 'vitest';
import mammoth from 'mammoth';
import { docxImageType, markdownToDocxBase64, type ResolvedDocxImage } from '../docx';

/** Smallest valid PNG (1×1 transparent pixel), base64. */
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function roundTrip(markdown: string, resolveImage?: DocxResolver): Promise<string> {
  const base64 = await markdownToDocxBase64(markdown, { resolveImage });
  const buffer = Buffer.from(base64, 'base64');
  const result = await mammoth.convertToHtml({ buffer });
  return result.value;
}
type DocxResolver = (src: string) => Promise<ResolvedDocxImage | null>;

describe('docxImageType', () => {
  test('maps raster extensions, case-insensitively', () => {
    expect(docxImageType('a/b/pic.PNG')).toBe('png');
    expect(docxImageType('pic.jpeg')).toBe('jpg');
    expect(docxImageType('pic.jpg')).toBe('jpg');
    expect(docxImageType('pic.gif')).toBe('gif');
    expect(docxImageType('pic.bmp')).toBe('bmp');
  });

  test('rejects formats docx cannot embed as plain rasters', () => {
    expect(docxImageType('pic.svg')).toBeNull();
    expect(docxImageType('pic.webp')).toBeNull();
    expect(docxImageType('README.md')).toBeNull();
  });
});

describe('markdownToDocxBase64', () => {
  test('produces a valid zip container (docx magic)', async () => {
    const base64 = await markdownToDocxBase64('# Hello\n\nWorld.');
    const bytes = Buffer.from(base64, 'base64');
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
  });

  test('round-trips headings, emphasis and inline code', async () => {
    const html = await roundTrip(
      '# Title\n\n## Sub\n\nSome **bold** and *italic* and ~~gone~~ and `code`.',
    );
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<h2>Sub</h2>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('code');
  });

  test('round-trips links as real hyperlinks', async () => {
    const html = await roundTrip('See [the site](https://example.com/page).');
    expect(html).toContain('href="https://example.com/page"');
    expect(html).toContain('the site');
  });

  test('resolves reference-style links via definitions', async () => {
    const html = await roundTrip('See [docs][d].\n\n[d]: https://example.com/docs');
    expect(html).toContain('href="https://example.com/docs"');
  });

  test('round-trips bulleted, ordered and nested lists', async () => {
    const html = await roundTrip('- one\n- two\n  1. sub a\n  2. sub b\n- three');
    expect(html).toContain('one');
    expect(html).toContain('sub b');
    // mammoth renders numbering as <ol>, bullets as <ul>.
    expect(html).toContain('<ol>');
    expect(html).toContain('<ul>');
  });

  test('renders GFM task-list checkboxes as text markers', async () => {
    const html = await roundTrip('- [x] done\n- [ ] todo');
    expect(html).toContain('☑');
    expect(html).toContain('☐');
  });

  test('round-trips tables with a header row', async () => {
    const html = await roundTrip('| a | b |\n| - | - |\n| 1 | 2 |');
    expect(html).toContain('<table>');
    expect(html).toContain('a');
    expect(html).toContain('2');
  });

  test('squares table rows to the header: short rows padded, extra cells dropped', async () => {
    // GFM lets body rows disagree with the header; the preview pads a short
    // row with empty cells and drops cells past the header's count. A ragged
    // Word table (cells off the grid) must not be the export's version of it.
    const html = await roundTrip('| A | B | C |\n| - | - | - |\n| 1 | 2 |\n| x | y | z | extra |');
    const rows = html.match(/<tr>.*?<\/tr>/g) ?? [];
    expect(rows.map((row) => row.match(/<t[hd]>/g)?.length)).toEqual([3, 3, 3]);
    expect(html).not.toContain('extra');
  });

  test('keeps fenced code blocks line by line', async () => {
    const html = await roundTrip('```js\nconst x = 1;\nconst y = 2;\n```');
    expect(html).toContain('const x = 1;');
    expect(html).toContain('const y = 2;');
  });

  test('embeds a resolved image', async () => {
    const resolve: DocxResolver = async () => ({
      data: TINY_PNG,
      type: 'png',
      width: 1,
      height: 1,
    });
    const html = await roundTrip('![alt text](pic.png)', resolve);
    expect(html).toContain('<img');
  });

  test('degrades an unresolved image to its alt text', async () => {
    const html = await roundTrip('![a broken image](https://cdn.example/pic.png)');
    expect(html).not.toContain('<img');
    expect(html).toContain('a broken image');
  });

  test('drops raw HTML, mirroring the preview sanitizer', async () => {
    const html = await roundTrip('before\n\n<script>alert(1)</script>\n\nafter');
    expect(html).not.toContain('alert(1)');
    expect(html).toContain('before');
    expect(html).toContain('after');
  });

  test('never rejects on odd-but-legal markdown', async () => {
    const gnarly = [
      '---',
      '',
      '> quoted **deep**',
      '>> deeper',
      '',
      'line one\\',
      'line two',
      '',
      'footnote here[^1]',
      '',
      '[^1]: the note body',
      '',
      '![ref image][img]',
      '',
      '[img]: local.webp',
    ].join('\n');
    const base64 = await markdownToDocxBase64(gnarly);
    expect(base64.length).toBeGreaterThan(0);
  });

  test('separate ordered lists each restart at 1', async () => {
    const html = await roundTrip('1. first a\n\ntext between\n\n1. second a\n2. second b');
    // Two independent <ol> blocks — mammoth reflects the split numbering refs.
    expect(html.match(/<ol>/g)?.length).toBe(2);
  });
});
