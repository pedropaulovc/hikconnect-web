import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

/**
 * Tiny in-app router. The Capacitor branch uses Ionic's URL router; on React
 * Native the idiomatic equivalent is a navigation stack, so we model the same
 * push/back experience with a route stack. Top-level destinations (sidebar)
 * reset the stack; tiles/rows push onto it.
 */
export type Route =
  | { name: 'wall' }
  | { name: 'cameraDetail'; cameraId: string }
  | { name: 'recordings' }
  | { name: 'playback'; recordingId: string }
  | { name: 'events' };

export type RouteName = Route['name'];

interface Navigator {
  route: Route;
  push: (route: Route) => void;
  replaceRoot: (route: Route) => void;
  back: () => void;
  canGoBack: boolean;
}

const NavContext = createContext<Navigator | null>(null);

export function NavProvider({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<Route[]>([{ name: 'wall' }]);

  const value = useMemo<Navigator>(
    () => ({
      route: stack[stack.length - 1],
      push: (route) => setStack((s) => [...s, route]),
      replaceRoot: (route) => setStack([route]),
      back: () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)),
      canGoBack: stack.length > 1,
    }),
    [stack],
  );

  return <NavContext.Provider value={value}>{children}</NavContext.Provider>;
}

export function useNav(): Navigator {
  const ctx = useContext(NavContext);
  if (!ctx) throw new Error('useNav must be used within NavProvider');
  return ctx;
}
