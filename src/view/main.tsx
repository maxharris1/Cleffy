import '@/lib/polyfills';

import React from 'react';
import ReactDOM from 'react-dom/client';

import { features } from '@/lib/features';
import { ViewApp } from '@/view/ViewApp';
import { tokenFromHash } from '@/view/viewToken';

import '@/index.css';

/**
 * Entry for /v (view.html), the under-13 view-link page. Deliberately not the
 * app: it imports none of src/main.tsx, the Supabase client, monitoring, the
 * service worker, web events or auth (tests/viewLinks/viewBundle.test.ts
 * checks the built chunks). The token comes from the URL fragment, which the
 * browser never sends to any server.
 */

const rootElement = document.getElementById('root');
if (!rootElement) {
    throw new Error('Root element #root not found');
}

ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
        <ViewApp token={tokenFromHash(window.location.hash)} enabled={features.viewLinks} />
    </React.StrictMode>,
);
