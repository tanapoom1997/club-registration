import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Table } from './table';

// jsdom has no layout, so each test gives the scrolling box the sizes a phone would.
const setBox = (element: HTMLElement, box: { client: number; scroll: number; left: number }) => {
  Object.defineProperty(element, 'clientWidth', { configurable: true, value: box.client });
  Object.defineProperty(element, 'scrollWidth', { configurable: true, value: box.scroll });
  Object.defineProperty(element, 'scrollLeft', { configurable: true, value: box.left });
  fireEvent.scroll(element);
};

const renderTable = () =>
  render(
    <Table aria-label="รายการชุมนุม">
      <tbody>
        <tr>
          <td>A100</td>
        </tr>
      </tbody>
    </Table>,
  );

const scroller = () => {
  const box = screen.getByRole('table').parentElement;
  if (!box) throw new Error('the table has no scrolling box');
  return box;
};

describe('Table on a narrow screen', () => {
  afterEach(cleanup);

  it('stays out of the tab order and the landmarks while it fits', () => {
    renderTable();
    setBox(scroller(), { client: 800, scroll: 800, left: 0 });

    expect(screen.queryByRole('region')).toBeNull();
    expect(scroller().hasAttribute('tabindex')).toBe(false);
  });

  it('becomes a focusable region named like the table once it is wider than the screen', () => {
    renderTable();
    setBox(scroller(), { client: 360, scroll: 900, left: 0 });

    const region = screen.getByRole('region', { name: 'รายการชุมนุม' });
    expect(region.getAttribute('tabindex')).toBe('0');
  });

  it('stays a region when scrolled to the far end', () => {
    renderTable();
    setBox(scroller(), { client: 360, scroll: 900, left: 540 });

    expect(screen.getByRole('region', { name: 'รายการชุมนุม' })).toBeTruthy();
  });
});
