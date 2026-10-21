import '@/lib/polyfills';

import React from 'react';
import ReactDOM from 'react-dom/client';

import { App } from '@/app/App';
import { captureAuthUrlError } from '@/features/auth/authUrlError';
import { monitoringEnabled, monitoringUserIdOf, setMonitoringUser, startMonitoring } from '@/lib/monitoring';
import { registerServiceWorker } from '@/lib/serviceWorker';
import { installStaleChunkRecovery } from '@/lib/staleChunk';
import { getSupabase, isSupabaseConfigured } from '@/lib/supabase';

import './index.css';

// A lazy chunk from the build this tab was loaded with can be gone after a
// deploy: reload once for the current build rather than go blank.
installStaleChunkRecovery();

// Before the Supabase client reads the URL and before any gate can redirect
// away from it: an expired email link's reason travels in the URL only.
captureAuthUrlError();

// Before the first render, so a crash in it is still reported. Without a
// VITE_SENTRY_DSN at build time this is a no-op and the SDK is not in the bundle.
startMonitoring();
if (monitoringEnabled() && isSupabaseConfigured()) {
    // Reports carry the account's opaque id and nothing else about who it is —
    // and for a roster student, not even that.
    getSupabase().auth.onAuthStateChange((_event, session) => setMonitoringUser(monitoringUserIdOf(session)));
}

// Offline support. Not at load on a first visit: see registerServiceWorker.
registerServiceWorker();

const rootElement = document.getElementById('root');
if (!rootElement) {
    throw new Error('Root element #root not found');
}

ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
        <App />
    </React.StrictMode>,
);
