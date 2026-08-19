import { createRoot } from 'react-dom/client';
import { setApiKey } from '@workspace/api-client';

import App from './App';

import './index.css';

// apps/server rejects every /api/* route (except /healthz) without a
// matching X-API-Key — see DEPLOY.md's "Authentication" section. Baked in
// at build time via Vite's VITE_-prefixed env handling, which means it is
// readable by anyone who can load this bundle (view-source, devtools
// network tab). That's an accepted tradeoff for this project's threat
// model (a self-hosted tool, not a multi-tenant service) as long as the
// deployment guidance is followed: put the whole app (this UI included)
// behind a private network/VPN, not directly on the public internet. The
// key still blocks a bot/scanner hitting the bare API port with nothing.
setApiKey(import.meta.env.VITE_API_KEY ?? null);

createRoot(document.getElementById('root')!).render(<App />);
