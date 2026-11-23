import { useCallback, useSyncExternalStore } from 'react';

// Below Tailwind's sm (40rem), for a component that has to render something else on a phone
// rather than restyle the same elements. max-width rather than the range syntax for older Safari.
export const PHONE_QUERY = '(max-width: 39.99rem)';

// Below Tailwind's md (48rem): a phone, or a tablet held upright, too narrow for a wide table.
export const BELOW_MD_QUERY = '(max-width: 47.99rem)';

// Whether the media query matches now, following changes (a turned phone, a resized window).
export const useMediaQuery = (query: string): boolean => {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
};
