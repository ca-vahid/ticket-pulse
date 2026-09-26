import { useEffect, useRef } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusables(root) {
  if (!root) return [];
  return Array.from(root.querySelectorAll(FOCUSABLE)).filter((el) => {
    // Radio groups: only the checked one (or the first when none is) is a tab stop.
    if (el.type === 'radio' && el.name) {
      const group = Array.from(root.querySelectorAll(`input[type="radio"][name="${el.name}"]`));
      const checked = group.find((r) => r.checked);
      return checked ? el === checked : el === group[0];
    }
    return true;
  });
}

/**
 * Modal focus handling for small hand-rolled dialogs:
 *  - Tab / Shift+Tab stay inside `containerRef` while `open`;
 *  - on close (or unmount) focus returns to whatever was focused when the
 *    dialog opened (the trigger), if it is still in the document.
 * `returnFocusRef` (optional) is the fallback when the element focused at
 * open time is gone by then (e.g. an option in a dropdown that closed).
 * Returns an onKeyDown handler to attach to the dialog root.
 */
export default function useDialogFocus(open, containerRef, returnFocusRef = null) {
  const returnTo = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    returnTo.current = typeof document !== 'undefined' ? document.activeElement : null;
    const fallbackRef = returnFocusRef; // the ref object; read .current at close time on purpose
    return () => {
      const captured = returnTo.current;
      returnTo.current = null;
      const usable = (n) => n && typeof n.focus === 'function' && n.isConnected && n !== document.body;
      const el = usable(captured) ? captured : fallbackRef?.current;
      if (usable(el)) {
        // After the portal unmounts, so the dialog's own blur does not win.
        setTimeout(() => { if (el.isConnected) el.focus({ preventScroll: true }); }, 0);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (e) => {
    if (e.key !== 'Tab') return;
    const items = focusables(containerRef.current);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    const inside = containerRef.current?.contains(active);
    if (e.shiftKey && (active === first || !inside)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !inside)) {
      e.preventDefault();
      first.focus();
    }
  };
}
