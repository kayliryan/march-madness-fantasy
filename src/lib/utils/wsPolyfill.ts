import ws from 'ws';

// Node 20 compat: @supabase/supabase-js constructs a RealtimeClient at createClient()
// time, which references globalThis.WebSocket. Import this module first (before any
// module that calls createClient) in scripts run via tsx.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).WebSocket ??= ws;
