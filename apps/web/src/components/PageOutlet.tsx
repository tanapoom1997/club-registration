import { Suspense, useEffect } from 'react';
import { NavigationType, Outlet, useLocation, useNavigationType } from 'react-router';
import { Button } from '@/components/ui/button';

// Where the lazily loaded pages render inside the layout. Keyed by path so every navigation gets a
// fresh boundary: a new boundary shows its fallback at once, whereas an existing one would keep
// the previous page on screen with no sign that the next one is still downloading.
export const PageOutlet = () => {
  const { pathname } = useLocation();
  return (
    <Suspense
      key={pathname}
      fallback={
        <p role="status" className="text-muted-foreground">
          กำลังโหลดหน้า…
        </p>
      }
    >
      <Outlet />
      <FocusHeadingOnNavigate />
    </Suspense>
  );
};

// A single-page app has no page load for a screen reader to announce, and focus stays on the menu
// link that was clicked. After an in-app navigation (a link, or the redirect after login), focus
// moves to the new page's h1 so the page that opened is read out and Tab carries on from its top.
// Not on the first load or Back/Forward (POP): there the browser's own focus is left alone.
// Inside the Suspense boundary, so it runs once the page itself has rendered, not its fallback.
const FocusHeadingOnNavigate = () => {
  const navigationType = useNavigationType();
  useEffect(() => {
    if (navigationType === NavigationType.Pop) return;
    const heading = document.querySelector<HTMLElement>('main h1');
    if (!heading) return;
    if (!heading.hasAttribute('tabindex')) {
      heading.tabIndex = -1;
      heading.classList.add('focus:outline-none');
    }
    heading.focus({ preventScroll: true });
  }, [navigationType]);
  return null;
};

// Route error element for the pages. The usual cause is a page file that no longer exists: a
// deploy replaced the hashed files while this tab still runs the old index.html, so the server
// answers 404. A reload fetches the new index.html and its files; retrying in place cannot help
// because a failed lazy import stays failed. Also covers a dropped connection mid-download.
export const PageLoadError = () => (
  <section role="alert" className="space-y-3 rounded-lg border border-border bg-card p-4">
    <h1 className="text-2xl font-bold">เปิดหน้านี้ไม่สำเร็จ</h1>
    <p className="text-sm">
      อาจเป็นเพราะการเชื่อมต่อขัดข้อง หรือระบบเพิ่งอัปเดตเป็นเวอร์ชันใหม่ กรุณาโหลดหน้าใหม่แล้วลองอีกครั้ง
    </p>
    <Button onClick={() => window.location.reload()}>โหลดหน้าใหม่</Button>
  </section>
);
