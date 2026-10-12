import { useEffect, useState } from 'react';

const QUERY = '(max-width: 767px)';

/** True below the `md` breakpoint (the widths that get the phone layouts). */
export default function useIsPhone() {
  const [phone, setPhone] = useState(() => Boolean(typeof window !== 'undefined' && window.matchMedia?.(QUERY)?.matches));
  useEffect(() => {
    const mq = window.matchMedia?.(QUERY);
    if (!mq) return undefined;
    const on = () => setPhone(mq.matches);
    on();
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return phone;
}
