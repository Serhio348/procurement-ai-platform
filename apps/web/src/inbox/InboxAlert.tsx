import { createContext, useContext, type ReactNode } from "react";

const InboxAlertContext = createContext(0);

export function InboxAlertProvider({
  count,
  children,
}: {
  count: number;
  children: ReactNode;
}) {
  return <InboxAlertContext.Provider value={count}>{children}</InboxAlertContext.Provider>;
}

export function useInboxAlertCount(): number {
  return useContext(InboxAlertContext);
}
