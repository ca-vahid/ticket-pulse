/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import RichTextEditor, { cleanPastedHtml, isRichContent, sanitizeRichHtml } from './RichTextEditor';
import { SafeHtml } from './ticketUi';

afterEach(() => {
  cleanup();
  delete document.execCommand;
});

// The <table> fragment Excel ACTUALLY puts on the clipboard (QA 08-17 #1):
// borders live in a comment-guarded <style> block via `.xl65` class hooks —
// there are NO inline border styles on the cells. This is the shape that used
// to lose its borders at paste (the earlier synthetic fixture had inline
// borders, which is why Phase C passed while real pastes failed).
const EXCEL_CLIPBOARD_HTML = `
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">
<head>
<meta name=ProgId content=Excel.Sheet>
<!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->
<style>
<!--table
	{mso-displayed-decimal-separator:"\\.";
	mso-displayed-thousand-separator:"\\,";}
td
	{padding-top:1px;
	color:black;
	font-size:11.0pt;
	font-weight:400;
	border:none;
	mso-protection:locked visible;
	white-space:nowrap;}
.xl65
	{font-weight:700;
	border:.5pt solid windowtext;
	background:#D9E1F2;
	mso-pattern:black none;}
.xl66
	{border:.5pt solid windowtext;}
-->
</style>
</head>
<body link="#0563C1" vlink="#954F72">
<table border=0 cellpadding=0 cellspacing=0 width=192 style='border-collapse:collapse;width:144pt'>
<col width=64 span=3 style='width:48pt'>
<tr height=20 style='height:15.0pt;mso-height-source:userset'>
 <td height=20 class=xl65 width=64 style='height:15.0pt;width:48pt'>Server</td>
 <td class=xl65 width=64 style='width:48pt'>Status</td>
 <td class=xl65 width=64 style='width:48pt'>Owner</td>
</tr>
<tr height=20 style='height:15.0pt'>
 <td height=20 class=xl66 style='height:15.0pt'>bgc-app-01 &amp; ok</td>
 <td class=xl66 colspan=2>Mehdi</td>
</tr>
</table>
<!--StartFragment--><!--EndFragment-->
</body>
</html>`;

// Outlook signature shape: o:p wrappers, mso-* runs, empty spans, a logo img.
const OUTLOOK_SIGNATURE_HTML = `
<div class=WordSection1>
<!--[if gte mso 9]><xml><o:OfficeDocumentSettings></o:OfficeDocumentSettings></xml><![endif]-->
<p class=MsoNormal style='mso-margin-top-alt:auto'><b><span style='font-size:11.0pt;mso-fareast-font-family:"Times New Roman";color:#1F4E79'>Jane Doe</span></b><o:p></o:p></p>
<p class=MsoNormal><span style='mso-bidi-font-size:10.0pt;color:#595959'>IT Coordinator | BGC Engineering</span><span></span><o:p>&nbsp;</o:p></p>
<p class=MsoNormal><img width=120 height=40 src="https://example.com/logo.png" alt="BGC"><o:p></o:p></p>
</div>`;

describe('cleanPastedHtml (MSO pre-pass)', () => {
  test('strips conditional comments, StartFragment markers and o:p wrappers', () => {
    const out = cleanPastedHtml(EXCEL_CLIPBOARD_HTML);
    expect(out).not.toContain('<!--[if');
    expect(out).not.toContain('StartFragment');
    expect(out).not.toContain('ExcelWorkbook');
    const sig = cleanPastedHtml(OUTLOOK_SIGNATURE_HTML);
    expect(sig).not.toContain('<o:p>');
    expect(sig).not.toContain('OfficeDocumentSettings');
    expect(sig).toContain('Jane Doe'); // content survives the unwrap
  });

  test('folds <style>-block class rules into inline styles (Excel keeps borders THERE, not inline)', () => {
    const out = cleanPastedHtml(EXCEL_CLIPBOARD_HTML);
    expect(out).not.toContain('<style'); // the block itself is gone
    // .xl65/.xl66 border + background rules now live inline on the cells.
    expect(out).toMatch(/<td[^>]*style="[^"]*border:\s*\.5pt solid windowtext/);
    expect(out).toMatch(/background:\s*#D9E1F2/);
    // Element-selector rules (bare td {…}) are NOT folded — class rules only.
    expect(out).not.toMatch(/mso-protection/);
    // The cell's own inline style is preserved after the folded declarations.
    expect(out).toMatch(/width:48pt/);
  });

  test('stamps every clipboard-born table with tp-data-table', () => {
    const out = cleanPastedHtml(EXCEL_CLIPBOARD_HTML);
    expect(out).toMatch(/<table[^>]*class="[^"]*tp-data-table/);
    // Tables without any <style> block are stamped too.
    const bare = cleanPastedHtml('<table><tbody><tr><td>1</td></tr></tbody></table>');
    expect(bare).toMatch(/<table[^>]*class="tp-data-table"/);
  });

  test('downlevel-revealed markers go away but their fallback content stays', () => {
    const out = cleanPastedHtml('<![if !vml]><img src="https://x.example/pic.png"><![endif]>');
    expect(out).not.toContain('<![if');
    expect(out).not.toContain('<![endif]');
    expect(out).toContain('<img src="https://x.example/pic.png">');
  });

  test('truly-empty spans are removed, spans with content are kept', () => {
    expect(cleanPastedHtml('a<span></span><span style="color:red"></span>b')).toBe('ab');
    expect(cleanPastedHtml('<span>keep me</span>')).toBe('<span>keep me</span>');
  });
});

describe('sanitizeRichHtml (widened allowlist)', () => {
  test('real Excel paste keeps structure, colspan and the folded borders; Office classes die', () => {
    const clean = sanitizeRichHtml(cleanPastedHtml(EXCEL_CLIPBOARD_HTML));
    expect(clean).toContain('<table');
    expect(clean).toContain('<col');
    expect(clean).toContain('colspan="2"');
    // Border survived the fold-in AND got normalized for browsers/email:
    // windowtext → #000, hairline .5pt → 1px.
    expect(clean).toMatch(/border: ?1px solid #000/);
    expect(clean).not.toMatch(/windowtext/);
    expect(clean).toMatch(/background: ?#D9E1F2/);
    expect(clean).toMatch(/font-weight: ?700/);
    // tp-* classes survive; Excel's xl65/xl66 hooks are stripped.
    expect(clean).toMatch(/class="tp-data-table"/);
    expect(clean).not.toMatch(/xl6[56]/);
    expect(clean).not.toMatch(/mso-/);
    expect(clean).not.toContain('height:15.0pt'); // height is not an allowed style prop
  });

  test('Outlook signature keeps bold name, colors and the https logo; MsoNormal class dies', () => {
    const clean = sanitizeRichHtml(cleanPastedHtml(OUTLOOK_SIGNATURE_HTML));
    expect(clean).toContain('Jane Doe');
    expect(clean).toMatch(/color: ?#1F4E79/);
    expect(clean).toContain('src="https://example.com/logo.png"');
    expect(clean).not.toMatch(/mso-/);
    expect(clean).not.toContain('MsoNormal');
    expect(clean).not.toContain('WordSection1');
    expect(clean).not.toContain('font-size'); // not on the style allowlist
  });

  test('XSS probes are stripped: script, onerror, javascript: href, style url()', () => {
    const clean = sanitizeRichHtml(
      '<table><tr><td style="background:url(https://evil.example/steal)">x</td></tr></table>'
      + '<script>alert(1)</script>'
      + '<img src="https://ok.example/a.png" onerror="alert(2)">'
      + '<a href="javascript:alert(3)">click</a>'
      + '<div style="color:#333;position:fixed;top:0">y</div>',
    );
    expect(clean).not.toContain('<script');
    expect(clean).not.toContain('onerror');
    expect(clean).not.toContain('javascript:');
    expect(clean).not.toContain('url(');
    expect(clean).not.toContain('position');
    expect(clean).toMatch(/color: ?#333/); // allowed props survive the filter
    expect(clean).toContain('src="https://ok.example/a.png"');
  });

  test('non-tp classes are dropped, tp-* classes are kept (re-sanitize safe)', () => {
    const clean = sanitizeRichHtml('<table class="tp-data-table xl65 MsoNormal"><tbody><tr><td class="xl66">1</td></tr></tbody></table>');
    expect(clean).toContain('class="tp-data-table"');
    expect(clean).not.toContain('xl65');
    expect(clean).not.toContain('xl66');
    expect(clean).not.toContain('MsoNormal');
    // A second pass (note re-edit) keeps the marker intact.
    expect(sanitizeRichHtml(clean)).toContain('class="tp-data-table"');
  });

  test('img src is https/data:image only — http and data:text/html images are removed', () => {
    expect(sanitizeRichHtml('<img src="data:image/png;base64,iVBORw0KGgo=">')).toContain('data:image/png');
    expect(sanitizeRichHtml('<img src="data:text/html;base64,PHNjcmlwdD4=">')).not.toContain('<img');
    expect(sanitizeRichHtml('<img src="http://insecure.example/a.png">')).not.toContain('<img');
  });
});

describe('isRichContent', () => {
  test('true for table-only and image-only bodies (they must ship as bodyHtml)', () => {
    expect(isRichContent('<table><tbody><tr><td>1</td></tr></tbody></table>')).toBe(true);
    expect(isRichContent('<img src="https://x.example/y.png">')).toBe(true);
    expect(isRichContent('<b>bold</b>')).toBe(true);
    expect(isRichContent('plain text with <Processed> token')).toBe(false);
  });
});

describe('RichTextEditor paste handling', () => {
  // jsdom implements neither innerText nor execCommand — shim both.
  const shimEditor = (editor) => {
    Object.defineProperty(editor, 'innerText', { get: () => editor.textContent });
    document.execCommand = vi.fn((cmd, _ui, val) => {
      if (cmd === 'insertHTML') editor.innerHTML += val;
      return true;
    });
  };

  const pasteInto = (editor, html) => {
    fireEvent.paste(editor, {
      clipboardData: {
        items: [],
        getData: (type) => (type === 'text/html' ? html : 'plain fallback'),
      },
    });
  };

  test('a real Excel paste lands as a stamped, bordered table and emits it', () => {
    const onChange = vi.fn();
    render(<RichTextEditor onChange={onChange} ariaLabel="Reply editor" />);
    const editor = screen.getByRole('textbox', { name: 'Reply editor' });
    shimEditor(editor);

    pasteInto(editor, EXCEL_CLIPBOARD_HTML);

    expect(document.execCommand).toHaveBeenCalledWith('insertHTML', false, expect.stringContaining('<table'));
    const inserted = document.execCommand.mock.calls.find(([cmd]) => cmd === 'insertHTML')[2];
    expect(inserted).not.toMatch(/mso-|xl6[56]/);
    expect(editor.querySelector('table.tp-data-table')).toBeTruthy();
    expect(editor.querySelector('td[colspan="2"]')).toBeTruthy();
    const emitted = onChange.mock.calls.at(-1)[0];
    // emit() re-sanitizes — the stamp and the folded borders must survive it.
    expect(emitted.html).toContain('tp-data-table');
    expect(emitted.html).toMatch(/border: ?1px solid #000/);
    expect(isRichContent(emitted.html)).toBe(true);
  });

  test('an Outlook signature paste keeps structure but sheds the mso junk', () => {
    const onChange = vi.fn();
    render(<RichTextEditor onChange={onChange} ariaLabel="Reply editor" />);
    const editor = screen.getByRole('textbox', { name: 'Reply editor' });
    shimEditor(editor);

    pasteInto(editor, OUTLOOK_SIGNATURE_HTML);

    const inserted = document.execCommand.mock.calls.find(([cmd]) => cmd === 'insertHTML')[2];
    expect(inserted).toContain('Jane Doe');
    expect(inserted).toContain('https://example.com/logo.png');
    expect(inserted).not.toMatch(/mso-|<o:p|WordSection/);
  });
});

// QA 08-17 #1 end-to-end (in jsdom): the stored bodyHtml renders through
// SafeHtml (the note/description render path) with the tp-data-table class
// intact, so `.tp-rich-body .tp-data-table` CSS can draw the cell borders.
describe('rendered note path (SafeHtml integration)', () => {
  test('paste → emit → SafeHtml keeps tp-data-table through DOMPurify', () => {
    const storedBodyHtml = sanitizeRichHtml(cleanPastedHtml(EXCEL_CLIPBOARD_HTML));
    const { container } = render(<SafeHtml html={storedBodyHtml} />);
    expect(container.querySelector('.tp-rich-body')).toBeTruthy();
    const table = container.querySelector('table.tp-data-table');
    expect(table).toBeTruthy();
    expect(container.innerHTML).not.toMatch(/xl6[56]/);
    // The folded, normalized border style reached the DOM too.
    expect(table.querySelector('td').getAttribute('style')).toMatch(/border: ?1px solid #000/);
  });
});
