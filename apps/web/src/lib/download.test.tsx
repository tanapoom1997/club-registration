import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveFile } from '@/lib/download';

describe('saveFile', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const setUp = () => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn(() => 'blob:fake');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const clicked: { href: string; download: string; attached: boolean }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push({ href: this.href, download: this.download, attached: this.isConnected });
    });
    return { createObjectURL, revokeObjectURL, clicked };
  };

  it('downloads the blob under the given name without leaving a link in the page', () => {
    const { createObjectURL, clicked } = setUp();
    const file = new Blob(['fictional'], { type: 'text/plain' });

    saveFile(file, 'passwords.xlsx');

    expect(createObjectURL).toHaveBeenCalledWith(file);
    expect(clicked).toEqual([{ href: 'blob:fake', download: 'passwords.xlsx', attached: true }]);
    expect(document.querySelector('a[download]')).toBeNull();
  });

  it('revokes the blob URL a second later so the file stops being reachable', () => {
    const { revokeObjectURL } = setUp();

    saveFile(new Blob(['fictional']), 'passwords.xlsx');

    vi.advanceTimersByTime(999);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake');
  });
});
