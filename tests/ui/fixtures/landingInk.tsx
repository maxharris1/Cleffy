import '@/index.css';
import '@/features/marketing/landing.css';

import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';

import { HeroDemo } from '@/features/marketing/HeroDemo';
import { LiveInkBand } from '@/features/marketing/LiveInkBand';

createRoot(document.getElementById('root')!).render(
    <MemoryRouter>
        <div style={{ height: '150vh' }} />
        <HeroDemo />
        <div style={{ height: '150vh' }} />
        <LiveInkBand />
    </MemoryRouter>,
);
