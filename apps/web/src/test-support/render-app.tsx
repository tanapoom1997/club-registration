import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { StrictMode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { vi } from 'vitest';
import { routes } from '@/routes';

// A Promise lets a test hold a request open or fail it the way a lost connection does.
export type Handler = (init: RequestInit | undefined) => Response | Promise<Response>;

// Routes requests by "METHOD /path" so each test states exactly what the API answers.
export const mockApi = (handlers: Record<string, Handler>) => {
  // The app only ever calls fetch with a path string.
  const fetchMock = vi.fn((input: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${input}`;
    const handler = handlers[key];
    return Promise.resolve(
      handler ? handler(init) : Response.json({ code: 'not_found', message: key }, { status: 404 }),
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

export const unauthorized = () =>
  Response.json({ code: 'unauthorized', message: 'Authentication required' }, { status: 401 });

// Mounts the real route tree, so tests exercise the same guards and layout as the app. strict
// wraps it in StrictMode as main.tsx does, for what must hold when effects run twice.
export const renderAt = (path: string, { strict = false } = {}) => {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const app = (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
  render(strict ? <StrictMode>{app}</StrictMode> : app);
  return router;
};
