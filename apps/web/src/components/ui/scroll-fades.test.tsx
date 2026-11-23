import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ScrollFades } from './scroll-fades';

const fade = (container: HTMLElement, side: 'start' | 'end') => {
  const element = container.querySelector<HTMLElement>(`[data-scroll-fade="${side}"]`);
  if (!element) throw new Error(`no ${side} fade`);
  return element;
};

describe('ScrollFades', () => {
  afterEach(cleanup);

  it('shows the fade, and with arrows a chevron, only on the side that still hides something', () => {
    const { container } = render(<ScrollFades start={false} end arrows />);

    expect(fade(container, 'end').className).not.toContain('opacity-0');
    expect(fade(container, 'end').querySelector('svg')).not.toBeNull();
    expect(fade(container, 'start').className).toContain('opacity-0');
  });

  it('is decorative: hidden from assistive technology', () => {
    const { container } = render(<ScrollFades start end arrows />);

    expect(fade(container, 'start').getAttribute('aria-hidden')).toBe('true');
    expect(fade(container, 'end').getAttribute('aria-hidden')).toBe('true');
  });

  it('draws no chevron for a table, whose content always runs under the fade', () => {
    const { container } = render(<ScrollFades start end />);

    expect(container.querySelector('svg')).toBeNull();
  });
});
