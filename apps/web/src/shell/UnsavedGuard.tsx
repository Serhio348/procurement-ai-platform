import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";

// Declarative <BrowserRouter>/<Routes> has no useBlocker (data routers only), so
// navigation guards live in a context: a dirty form registers a blocker, shell
// navigation asks it before leaving. Back/forward in history is not covered —
// only in-app links and close/reload (via beforeunload in the form itself).
interface UnsavedGuard {
  confirmLeave(): boolean;
  setBlocker(blocker: (() => boolean) | undefined): void;
}

const noGuard: UnsavedGuard = {
  confirmLeave: () => true,
  setBlocker: () => undefined,
};

const UnsavedGuardContext = createContext<UnsavedGuard>(noGuard);

export function UnsavedGuardProvider({ children }: { children: ReactNode }): ReactElement {
  const blockerRef = useRef<(() => boolean) | undefined>(undefined);
  const guardRef = useRef<UnsavedGuard>({
    confirmLeave: () => blockerRef.current?.() ?? true,
    setBlocker: (blocker) => {
      blockerRef.current = blocker;
    },
  });
  return <UnsavedGuardContext.Provider value={guardRef.current}>{children}</UnsavedGuardContext.Provider>;
}

// Registers `confirm(message)` as the leave-blocker while `active` is true.
export function useUnsavedChanges(active: boolean, message: string): void {
  const guard = useContext(UnsavedGuardContext);
  useEffect(() => {
    if (!active) return undefined;
    guard.setBlocker(() => window.confirm(message));
    return () => {
      guard.setBlocker(undefined);
    };
  }, [active, message, guard]);
}

// onClick handler for navigation links that must ask before leaving.
export function useGuardedClick(): (event: MouseEvent<HTMLAnchorElement>) => void {
  const guard = useContext(UnsavedGuardContext);
  return (event) => {
    if (!guard.confirmLeave()) event.preventDefault();
  };
}
