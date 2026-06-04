import AppHeader from './AppHeader';

export const APP_BACKGROUND_STYLE = {
  backgroundImage: 'url(/brand/dashboard-background.webp)',
};

export const APP_BACKGROUND_CLASS = 'bg-gray-100 bg-no-repeat bg-cover bg-fixed';

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
      className={`relative ${fillViewport ? 'flex h-[100dvh] flex-col overflow-hidden' : 'min-h-screen'} ${APP_BACKGROUND_CLASS} ${className}`}
      style={APP_BACKGROUND_STYLE}
    >
      <AppHeader activePage={activePage} {...headerProps} />
      <main className={fillViewport ? `min-h-0 flex-1 overflow-hidden ${contentClassName}` : contentClassName}>
        {children}
      </main>
    </div>
  );
}
