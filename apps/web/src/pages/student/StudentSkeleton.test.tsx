import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { StudentLoadState } from './RoundHeader';

describe('the loading state of a student page (U4)', () => {
  afterEach(cleanup);

  it.each(['clubs-page', 'clubs', 'result'] as const)(
    'says "loading" in words and keeps the %s outline from screen readers',
    (shape) => {
      const { container } = render(
        <StudentLoadState error={null} isPending onRetry={() => undefined} skeleton={shape} />,
      );

      expect(screen.getByText('กำลังโหลด…')).toBeTruthy();
      const outline = container.querySelector('[aria-hidden="true"]');
      expect(outline?.childElementCount).toBeGreaterThan(0);
      expect(outline?.textContent).toBe('');
    },
  );

  it('offers a retry instead of the outline once loading failed', () => {
    render(
      <StudentLoadState
        error={new Error('offline')}
        isPending={false}
        onRetry={() => undefined}
        skeleton="clubs-page"
      />,
    );

    expect(screen.getByRole('alert').textContent).toContain('โหลดข้อมูลไม่สำเร็จ');
    expect(screen.queryByText('กำลังโหลด…')).toBeNull();
  });
});
