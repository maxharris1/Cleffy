import ReactDOM from 'react-dom/client';

import { PricingDialog } from '@/features/billing/PricingDialog';

import '../src/index.css';

const tier = new URLSearchParams(window.location.search).get('tier') === 'teacher' ? 'teacher' : 'free';

ReactDOM.createRoot(document.getElementById('root')!).render(<PricingDialog currentTier={tier} onClose={() => {}} />);
