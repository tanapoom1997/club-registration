import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CheckboxRow } from './CheckboxRow';

describe('CheckboxRow', () => {
  afterEach(cleanup);

  it('is named by its label alone and described by the line under it', () => {
    render(
      <CheckboxRow
        id="only-new"
        label="เฉพาะคนใหม่"
        description="ไม่แตะของเดิม"
        checked={false}
        onChange={() => undefined}
      />,
    );

    const box = screen.getByRole('checkbox', { name: 'เฉพาะคนใหม่' });
    const descriptionId = box.getAttribute('aria-describedby');
    expect(
      descriptionId === null ? null : document.getElementById(descriptionId)?.textContent,
    ).toBe('ไม่แตะของเดิม');
  });

  it('reports the new state when the row is clicked anywhere', () => {
    const onChange = vi.fn();
    render(<CheckboxRow id="only-new" label="เฉพาะคนใหม่" checked={false} onChange={onChange} />);

    fireEvent.click(screen.getByText('เฉพาะคนใหม่'));

    expect(onChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole('checkbox').getAttribute('aria-describedby')).toBeNull();
  });
});
