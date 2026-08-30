import AppHeader from './AppHeader';
import MobileTabBar from './nav/MobileTabBar';

// Ground art is class-driven (`.tp-app-backdrop` in index.css picks the light
// photo or the DM0 dark contour texture under `.dark`), so no inline style is
// needed any more. The STYLE export stays for callers that spread it.
export const APP_BACKGROUND_STYLE = {};

export const APP_BACKGROUND_CLASS = 'tp-app-backdrop bg-background bg-no-repeat bg-cover bg-fixed';

// Reserves room for the fixed mobile tab bar (md:hidden) so content isn't
// hidden behind it; collapses to nothing from md upward.
const MOBILE_NAV_INSET = 'pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-0';

export default function AppShell({
  activePage = 'dashboard',
  children,
  className = '',
  contentClassName = 'max-w-7xl mx-auto w-full px-2 sm:px-4 py-3',
  headerProps = {},
  fillViewport = false,
}) {
  return (
    <div
      className={`relative md:pl-[58px] ${fillViewport ? 'flex h-[100dvh] flex-col overflow-hidden' : 'min-h-screen'} ${MOBILE_NAV_INSET} ${APP_BACKGROUND_CLASS} ${className}`}
      style={APP_BACKGROUND_STYLE}
    >
      <AppHeader activePage={activePage} {...headerProps} />
      <main className={fillViewport ? `min-h-0 flex-1 overflow-hidden ${contentClassName}` : contentClassName}>
        {children}
      </main>
      <MobileTabBar />
    </div>
  );
}
