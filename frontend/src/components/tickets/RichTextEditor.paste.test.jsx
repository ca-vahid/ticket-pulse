/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import RichTextEditor, { cleanPastedHtml, isRichContent, sanitizeRichHtml } from './RichTextEditor';

afterEach(() => {
  cleanup();
  delete document.execCommand;
});

// The <table> fragment Excel actually puts on the clipboard: Office namespace
// xml, conditional comments, class-based styles, mso-* declarations, <col>s.
const EXCEL_CLIPBOARD_HTML = `
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">
<head>
<!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->
</head>
<body link=blue vlink=purple>
<table border=0 cellpadding=0 cellspacing=0 width=256 style='border-collapse:collapse;width:192pt'>
<col width=64 span=2 style='width:48pt'>
<tr height=20 style='height:15.0pt;mso-height-source:userset'>
 <td height=20 width=64 style='height:15.0pt;width:48pt;border:.5pt solid windowtext;font-weight:700;mso-ignore:padding'>Server</td>
 <td width=64 style='width:48pt;border:.5pt solid windowtext;mso-ignore:padding'>Status</td>
</tr>
<tr height=20 style='height:15.0pt'>
 <td height=20 colspan=2 style='height:15.0pt;border:.5pt solid windowtext;background:#FFFF00;mso-pattern:black none'>bgc-app-01 &amp; ok</td>
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
  test('Excel-shaped table survives with structure, colspan and border styles; mso-* styles die', () => {
    const clean = sanitizeRichHtml(cleanPastedHtml(EXCEL_CLIPBOARD_HTML));
    expect(clean).toContain('<table');
    expect(clean).toContain('<col');
    expect(clean).toContain('colspan="2"');
    expect(clean).toMatch(/border: ?\.5pt solid windowtext/);
    expect(clean).toMatch(/background: ?#FFFF00/);
    expect(clean).not.toMatch(/mso-/);
    expect(clean).not.toContain('height:15.0pt'); // height is not an allowed style prop
  });

  test('Outlook signature keeps bold name, colors and the https logo', () => {
    const clean = sanitizeRichHtml(cleanPastedHtml(OUTLOOK_SIGNATURE_HTML));
    expect(clean).toContain('Jane Doe');
    expect(clean).toMatch(/color: ?#1F4E79/);
    expect(clean).toContain('src="https://example.com/logo.png"');
    expect(clean).not.toMatch(/mso-/);
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

  test('an Excel clipboard paste lands as a real table in the editor and emits table html', () => {
    const onChange = vi.fn();
    render(<RichTextEditor onChange={onChange} ariaLabel="Reply editor" />);
    const editor = screen.getByRole('textbox', { name: 'Reply editor' });
    shimEditor(editor);

    pasteInto(editor, EXCEL_CLIPBOARD_HTML);

    expect(document.execCommand).toHaveBeenCalledWith('insertHTML', false, expect.stringContaining('<table'));
    const inserted = document.execCommand.mock.calls.find(([cmd]) => cmd === 'insertHTML')[2];
    expect(inserted).not.toMatch(/mso-/);
    expect(editor.querySelector('table')).toBeTruthy();
    expect(editor.querySelector('td[colspan="2"]')).toBeTruthy();
    const emitted = onChange.mock.calls.at(-1)[0];
    expect(emitted.html).toContain('<table');
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
