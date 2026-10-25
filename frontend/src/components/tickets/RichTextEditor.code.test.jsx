/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import RichTextEditor, { cleanPastedHtml, htmlToPlainText, isRichContent, sanitizeRichHtml } from './RichTextEditor';

// 25 Oct 2026: a PowerShell fix pasted into an internal note lost its code
// block and every line break. Code blocks, inline code and quotes now survive,
// and the composer can go full screen.
afterEach(() => {
  cleanup();
  delete document.execCommand;
});

const SCRIPT = '$user = (Get-CimInstance Win32_ComputerSystem).UserName\n\n# Back up and reset\nStop-Process -Name CRBasicEditor -Force';

describe('code survives', () => {
  test('a rendered code block keeps its lines and loses its dark theme', () => {
    const html = sanitizeRichHtml(`<p>Fix</p><pre style="background:#0d1117;color:#fff"><code class="language-powershell"><span style="color:#ff7b72">${SCRIPT}</span></code></pre>`);
    expect(html).toContain('<pre><code>');
    expect(html).not.toMatch(/style=/);
    expect(htmlToPlainText(html)).toContain('UserName\n\n# Back up and reset\nStop-Process');
  });

  test('inline code, quotes, rules and strike are kept, and count as rich', () => {
    const html = sanitizeRichHtml('<p>Run <code>gpupdate /force</code></p><blockquote>quoted</blockquote><hr><s>old</s>');
    expect(html).toBe('<p>Run <code>gpupdate /force</code></p><blockquote>quoted</blockquote><hr><s>old</s>');
    expect(isRichContent('<pre><code>x</code></pre>')).toBe(true);
    expect(isRichContent('<p>Run <code>x</code></p>')).toBe(true);
    expect(isRichContent('<p><span>plain</span></p>')).toBe(false);
  });

  test('a VS Code copy becomes a code block with its indentation', () => {
    const vscode = '<div style="color: #d4d4d4;background-color: #1e1e1e;font-family: Consolas, \'Courier New\', monospace;white-space: pre;">'
      + '<div><span style="color: #c586c0;">if</span><span> ($x) {</span></div>'
      + '<div><span>    Write-Host </span><span style="color: #ce9178;">"hi"</span></div>'
      + '<div><br></div><div><span>}</span></div></div>';
    const html = sanitizeRichHtml(cleanPastedHtml(vscode));
    expect(html).toBe('<pre><code>if ($x) {\n    Write-Host "hi"\n\n}</code></pre>');
  });

  test('a pre-wrap e-mail paragraph in a normal font stays prose', () => {
    const html = sanitizeRichHtml(cleanPastedHtml('<p style="white-space: pre-wrap; font-family: Calibri">Hello there</p>'));
    expect(html).not.toContain('<pre>');
    expect(html).toContain('Hello there');
  });
});

describe('composer controls', () => {
  test('the toolbar offers quote, inline code and code block', () => {
    render(<RichTextEditor value="" onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Quote' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Inline code' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Code block' })).toBeInTheDocument();
    // No host, no full-screen toggle.
    expect(screen.queryByRole('button', { name: 'Full screen' })).toBeNull();
  });

  test('the full-screen toggle is the host\'s, and the editor drops its height cap', () => {
    const toggle = vi.fn();
    const { rerender } = render(<RichTextEditor value="" onChange={() => {}} onToggleExpand={toggle} />);
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('textbox')).toHaveStyle({ maxHeight: '460px' });

    rerender(<RichTextEditor value="" onChange={() => {}} onToggleExpand={toggle} expanded />);
    const exit = screen.getByRole('button', { name: 'Exit full screen' });
    expect(exit).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('textbox').style.maxHeight).toBe('none');
  });

  test('the code block button wraps the selection in a code block', () => {
    const onChange = vi.fn();
    render(<RichTextEditor value="<p>Get-Process</p>" onChange={onChange} />);
    const box = screen.getByRole('textbox');
    const range = document.createRange();
    range.selectNodeContents(box.querySelector('p'));
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    document.execCommand = vi.fn((cmd, _ui, html) => {
      if (cmd === 'insertHTML') box.querySelector('p').outerHTML = html;
      return true;
    });
    fireEvent.click(screen.getByRole('button', { name: 'Code block' }));
    expect(document.execCommand).toHaveBeenCalledWith('insertHTML', false, expect.stringContaining('<code>Get-Process</code>'));
    const last = onChange.mock.calls.at(-1)[0];
    expect(last.html).toContain('<pre><code>Get-Process</code></pre>');
    expect(last.html).not.toContain('data-tp-new');
  });

  test('a paste inside a code block goes in as plain text', () => {
    render(<RichTextEditor value="<pre><code>x</code></pre><p>after</p>" onChange={() => {}} />);
    const box = screen.getByRole('textbox');
    const code = box.querySelector('code');
    const range = document.createRange();
    range.selectNodeContents(code);
    range.collapse(false);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    document.execCommand = vi.fn(() => true);
    fireEvent.paste(box, {
      clipboardData: {
        items: [],
        getData: (type) => (type === 'text/plain' ? 'a\r\n  b' : '<p>a</p><p>  b</p>'),
      },
    });
    expect(document.execCommand).toHaveBeenCalledWith('insertText', false, 'a\n  b');
  });
});
