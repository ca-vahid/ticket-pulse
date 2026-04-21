import { useEffect, useRef, useState } from 'react';
import { Camera, Shuffle, ImageOff, Image as ImageIcon, Check } from 'lucide-react';
import {
  useDemoMode,
  setDemoMode,
  arePhotosEnabled,
  setPhotosEnabled,
  reshuffleIdentities,
} from '../utils/demoMode';

/**
 * DemoModeToggle — small button + dropdown for activating demo mode during
 * screen recordings. Designed to live in the Dashboard header next to the
 * Cards/Compact and Hide Noise toggles.
 *
 * Props:
 *   - onChange?: () => void   Called after the demo flag flips, after
 *                             reshuffle, or after the photos sub-toggle
 *                             flips. Use it to invalidate caches and
 *                             re-fetch dashboard data so the new (real or
 *                             fake) values render immediately.
 */
export default function DemoModeToggle({ onChange }) {
  const enabled = useDemoMode();
  const [open, setOpen] = useState(false);
  const [photosOn, setPhotosOn] = useState(() => arePhotosEnabled());
  const wrapperRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const handler = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const toggle = () => {
    setDemoMode(!enabled);
    if (onChange) onChange();
  };

  const handleReshuffle = () => {
    reshuffleIdentities();
    setOpen(false);
    if (onChange) onChange();
  };

  const handleTogglePhotos = () => {
    const next = !photosOn;
    setPhotosOn(next);
    setPhotosEnabled(next);
    if (onChange) onChange();
  };

  return (
    <div ref={wrapperRef} className="relative inline-flex">
      <button
        onClick={toggle}
        className={`flex items-center gap-1.5 px-3 py-1 rounded-l-lg text-sm transition-colors border ${
          enabled
            ? 'bg-amber-100 hover:bg-amber-200 text-amber-800 ring-1 ring-amber-300 border-amber-300'
            : 'bg-gray-100 hover:bg-gray-200 text-gray-600 border-transparent'
        }`}
        title={enabled
          ? 'Demo Mode is ON. All sensitive data is anonymized.'
          : 'Click to anonymize all data for screen recordings.'}
      >
        <Camera className="w-4 h-4" />
        <span>{enabled ? 'Demo Mode: ON' : 'Demo Mode'}</span>
      </button>
      <button
        onClick={() => setOpen((v) => !v)}
        className={`px-1.5 py-1 rounded-r-lg text-sm transition-colors border-l ${
          enabled
            ? 'bg-amber-100 hover:bg-amber-200 text-amber-800 ring-1 ring-amber-300 border-amber-300 border-l-amber-400'
            : 'bg-gray-100 hover:bg-gray-200 text-gray-600 border-l-gray-300'
        }`}
        title="Demo Mode options"
        aria-label="Demo Mode options"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><path d="M2 4l3 3 3-3z" /></svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-60 bg-white border border-gray-200 rounded-lg shadow-lg py-1 text-sm">
          <button
            onClick={handleReshuffle}
            disabled={!enabled}
            className="w-full flex items-center gap-2 px-3 py-2 text-left text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
            title={enabled ? 'Generate a fresh set of fake identities' : 'Turn Demo Mode on first'}
          >
            <Shuffle className="w-4 h-4 text-gray-500" />
            Reshuffle identities
          </button>
          <button
            onClick={handleTogglePhotos}
            className="w-full flex items-center justify-between px-3 py-2 text-left text-gray-700 hover:bg-gray-50"
          >
            <span className="flex items-center gap-2">
              {photosOn ? <ImageIcon className="w-4 h-4 text-gray-500" /> : <ImageOff className="w-4 h-4 text-gray-500" />}
              Replace photos
            </span>
            {photosOn && <Check className="w-4 h-4 text-emerald-600" />}
          </button>
          <div className="border-t border-gray-100 my-1" />
          <p className="px-3 py-2 text-[11px] leading-snug text-gray-500">
            Each new tab/recording gets a fresh roster of fake identities. Real names, emails, locations, computer names and ticket subjects are scrubbed before reaching any component.
          </p>
        </div>
      )}
    </div>
  );
}
