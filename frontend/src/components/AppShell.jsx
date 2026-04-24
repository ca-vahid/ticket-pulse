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
}) {
  return (
    <div
      className={`min-h-screen relative ${APP_BACKGROUND_CLASS} ${className}`}
      style={APP_BACKGROUND_STYLE}
    >
      <AppHeader activePage={activePage} {...headerProps} />
      <main className={contentClassName}>
        {children}
      </main>
    </div>
  );
}
