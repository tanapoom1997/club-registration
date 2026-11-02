import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { HealthPage } from '@/pages/HealthPage';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={new QueryClient()}>
      <HealthPage />
    </QueryClientProvider>
  </StrictMode>,
);
