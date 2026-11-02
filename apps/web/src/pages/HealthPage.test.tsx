import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HealthPage } from './HealthPage';

const renderPage = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <HealthPage />
    </QueryClientProvider>,
  );

const statusOf = (label: string) => within(screen.getByText(label).parentElement as HTMLElement);

describe('HealthPage', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows both services as working when the API reports ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ status: 'ok', database: 'up' }))),
    );

    renderPage();

    expect(await statusOf('API').findByText('ทำงานปกติ')).toBeTruthy();
    expect(await statusOf('ฐานข้อมูล').findByText('ทำงานปกติ')).toBeTruthy();
  });

  it('shows the database as down when the API answers 503', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(Response.json({ status: 'degraded', database: 'down' }, { status: 503 })),
      ),
    );

    renderPage();

    expect(await statusOf('API').findByText('ทำงานปกติ')).toBeTruthy();
    expect(await statusOf('ฐานข้อมูล').findByText('เชื่อมต่อไม่ได้')).toBeTruthy();
  });

  it('shows the API as unreachable when the request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );

    renderPage();

    expect(await statusOf('API').findByText('เชื่อมต่อไม่ได้')).toBeTruthy();
    expect(await statusOf('ฐานข้อมูล').findByText('ไม่ทราบสถานะ')).toBeTruthy();
  });
});
