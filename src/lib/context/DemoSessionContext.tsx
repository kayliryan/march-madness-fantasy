'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';

// Section 14.2 — app-level state shared by both demo flows (read-only standings
// and "Try as Commissioner" provisioning). Most recent token always overwrites.
export interface DemoSession {
  access_token: string;
  expires_at: string;
  league_id?: string; // set after provisioning, undefined for read-only demo session
  draft_session_id?: string; // set after provisioning
}

interface DemoSessionContextValue {
  demoSession: DemoSession | null;
  setDemoSession: (session: DemoSession | null) => void;
}

const DemoSessionContext = createContext<DemoSessionContextValue | undefined>(undefined);

export function DemoSessionProvider({ children }: { children: ReactNode }) {
  const [demoSession, setDemoSession] = useState<DemoSession | null>(null);

  return (
    <DemoSessionContext.Provider value={{ demoSession, setDemoSession }}>
      {children}
    </DemoSessionContext.Provider>
  );
}

export function useDemoSession(): DemoSessionContextValue {
  const ctx = useContext(DemoSessionContext);
  if (!ctx) throw new Error('useDemoSession must be used within a DemoSessionProvider');
  return ctx;
}
