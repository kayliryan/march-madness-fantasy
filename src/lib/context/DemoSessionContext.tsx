'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';

// Section 14.2 — app-level state shared by both demo flows (read-only standings
// and "Try as Commissioner" provisioning). Most recent token always overwrites.
// This in-memory state does NOT survive a page refresh on its own — see the
// localStorage helpers below for the piece that does.
export interface DemoSession {
  access_token: string;
  expires_at: string;
  league_id?: string; // set after provisioning, undefined for read-only demo session
  draft_session_id?: string; // set after provisioning
}

// Refresh-survival for the *provisioned* commissioner flow only (never the
// read-only /demo/league session, which has no league_id and is cheap to
// re-establish from scratch). Without this, a hiring manager who provisions,
// explores, and comes back to `/` later sees the original CTA again — clicking
// it re-provisions a second league, burning a slot of the Layer 2 concurrent
// cap and orphaning the first one. This module only owns the raw
// read/write/clear; DemoCTAs is responsible for re-validating the stored
// value against the server (anonymous session still valid, league still
// exists) before trusting it — a stale or tampered value must never be
// trusted on its own.
export const DEMO_LEAGUE_STORAGE_KEY = 'demo_league';

export interface StoredDemoLeague {
  league_id: string;
  draft_session_id: string;
}

export function readStoredDemoLeague(): StoredDemoLeague | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(DEMO_LEAGUE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredDemoLeague> | null;
    if (!parsed || typeof parsed.league_id !== 'string' || typeof parsed.draft_session_id !== 'string') {
      return null;
    }
    return { league_id: parsed.league_id, draft_session_id: parsed.draft_session_id };
  } catch {
    return null;
  }
}

export function writeStoredDemoLeague(data: StoredDemoLeague): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DEMO_LEAGUE_STORAGE_KEY, JSON.stringify(data));
  } catch {
    // localStorage unavailable (private browsing, quota exceeded) — non-fatal,
    // just means a refresh won't restore the session. Provisioning itself
    // still succeeds either way.
  }
}

export function clearStoredDemoLeague(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(DEMO_LEAGUE_STORAGE_KEY);
  } catch {
    // no-op
  }
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
