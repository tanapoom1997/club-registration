import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ClubSeats } from './ClubSeats';

describe('ClubSeats', () => {
  afterEach(cleanup);

  it('shows registered over capacity and what is left', () => {
    const { container } = render(<ClubSeats capacity={30} registered={12} remaining={18} />);

    expect(container.textContent).toBe('12 / 30เหลือ 18');
  });

  it('says a full club is full in words, not only with the bar', () => {
    render(<ClubSeats capacity={3} registered={3} remaining={0} />);

    expect(screen.getByText('เต็ม')).toBeTruthy();
    expect(screen.queryByText(/^เหลือ/)).toBeNull();
  });
});
