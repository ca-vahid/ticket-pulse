import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/**
 * Settings section ⇄ URL-hash sync (QA 08-17 #3, banner half).
 *
 * The old implementation read `window.location.hash` only in the useState
 * initializer and wrote clicks back with `history.replaceState` — invisible to
 * the router, so a banner deep link (`/settings#notification-providers`)
 * clicked while ALREADY on /settings changed the hash without changing the
 * rendered section. This hook keeps the section reactive to `location.hash`
 * (deep links work from inside Settings) and routes clicks through
 * `navigate`, so router state and the address bar never diverge.
 *
 * Returns `[activeSection, setActiveSection]` — activeSection is the user's
 * REQUEST; callers still resolve it against the role-filtered nav list.
 */
export default function useSettingsSectionHash() {
  const location = useLocation();
  const navigate = useNavigate();
  const [activeSection, setActiveSectionRaw] = useState(
    () => (location.hash || '').replace('#', '') || null,
  );

  // Deep links while already mounted: a hash change (banner link, back/forward)
  // updates the section. An empty hash keeps the current section rather than
  // yanking the user back to the default.
  useEffect(() => {
    const fromHash = (location.hash || '').replace('#', '');
    if (fromHash) setActiveSectionRaw(fromHash);
  }, [location.hash]);

  // Nav clicks: update state immediately (no flicker waiting on the router)
  // and replace the hash via the router so the location object stays honest.
  const setActiveSection = useCallback((id) => {
    setActiveSectionRaw(id);
    navigate({ hash: `#${id}` }, { replace: true });
  }, [navigate]);

  return [activeSection, setActiveSection];
}
