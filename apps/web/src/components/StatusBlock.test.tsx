import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmptyState, LoadFailed } from './StatusBlock';

describe('StatusBlock (U7)', () => {
  afterEach(cleanup);

  it('says what failed as an alert, with a retry that never submits a form', () => {
    const onRetry = vi.fn();
    const onSubmit = vi.fn();
    render(
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <LoadFailed message="โหลดรายการรอบไม่สำเร็จ" onRetry={onRetry} />
      </form>,
    );

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('โหลดรายการรอบไม่สำเร็จลองใหม่');
    fireEvent.click(within(alert).getByRole('button', { name: 'ลองใหม่' }));

    expect(onRetry).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows an empty slot with its words and any link in it, and no alert', () => {
    render(
      <EmptyState>
        ยังไม่มีรอบลงทะเบียน ให้<a href="/admin/rounds">สร้างรอบ</a>ก่อน
      </EmptyState>,
    );

    expect(screen.getByRole('link', { name: 'สร้างรอบ' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
