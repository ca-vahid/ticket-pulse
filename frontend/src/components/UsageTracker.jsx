import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { startUsageTracking, stopUsageTracking, trackPage } from '../utils/usageTracker';

/**
 * Site stats: reports the page a signed-in person has open (name only) and
 * the time on it. Renders nothing. See utils/usageTracker.js for the rules
 * and Settings -> Site stats for the reader.
 */
export default function UsageTracker() {
  const location = useLocation();
  const { isAuthenticated } = useAuth();

  useEffect(() => {
    if (!isAuthenticated) return undefined;
    startUsageTracking();
    return () => stopUsageTracking();
  }, [isAuthenticated]);

  useEffect(() => {
    if (isAuthenticated) trackPage(location);
  // Only the parts that decide the page name; `location` itself changes on every navigation.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, location.pathname, location.hash, location.search]);

  return null;
}
