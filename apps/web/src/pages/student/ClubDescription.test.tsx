import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClubDescription } from './ClubDescription';

// A made-up club.
const CLUB = 'C01 ชุมนุมสมมติ';
const TEXT = 'บรรทัดหนึ่ง\nบรรทัดสอง\nบรรทัดสาม\nบรรทัดสี่';

// jsdom lays nothing out: these stand in for a box whose text is taller than what it shows.
const layOut = (contentHeight: number, boxHeight: number) => {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(contentHeight);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(boxHeight);
};

const description = () => screen.getByText(/บรรทัดหนึ่ง/);

describe('a club description on a phone (U6)', () => {
  afterEach(cleanup);

  it('shows the first lines of a long description with a button for the rest', () => {
    layOut(120, 60);
    render(<ClubDescription description={TEXT} clubLabel={CLUB} />);

    const more = screen.getByRole('button', { name: `อ่านต่อ รายละเอียดชุมนุม ${CLUB}` });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(more.getAttribute('aria-controls')).toBe(description().id);
    expect(description().className).toContain('max-sm:line-clamp-3');
    // The whole text is in the page, for a screen reader, while only three lines show.
    expect(description().textContent).toBe(TEXT);
  });

  it('shows the whole description, then folds it again', () => {
    layOut(120, 60);
    render(<ClubDescription description={TEXT} clubLabel={CLUB} />);

    fireEvent.click(screen.getByRole('button', { name: /^อ่านต่อ/ }));

    const less = screen.getByRole('button', { name: `ย่อ รายละเอียดชุมนุม ${CLUB}` });
    expect(less.getAttribute('aria-expanded')).toBe('true');
    expect(description().className).not.toContain('line-clamp');

    fireEvent.click(less);

    expect(screen.getByRole('button', { name: /^อ่านต่อ/ })).toBeTruthy();
    expect(description().className).toContain('max-sm:line-clamp-3');
  });

  it('gives a description that fits no button', () => {
    layOut(60, 60);
    render(<ClubDescription description="สั้น ๆ" clubLabel={CLUB} />);

    expect(screen.getByText('สั้น ๆ')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('ignores the pixel a zoomed page can be short by', () => {
    layOut(61, 60);
    render(<ClubDescription description="สั้น ๆ" clubLabel={CLUB} />);

    expect(screen.queryByRole('button')).toBeNull();
  });
});
