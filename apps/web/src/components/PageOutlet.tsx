import { Suspense } from 'react';
import { Outlet, useLocation } from 'react-router';
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
    </Suspense>
  );
};

// Route error element for the pages. The usual cause is a page file that no longer exists: a
// deploy replaced the hashed files while this tab still runs the old index.html, so the server
// answers 404. A reload fetches the new index.html and its files; retrying in place cannot help
// because a failed lazy import stays failed. Also covers a dropped connection mid-download.
export const PageLoadError = () => (
  <section role="alert" className="space-y-3 rounded-lg border border-border bg-card p-4">
    <h1 className="text-2xl font-bold">เปิดหน้านี้ไม่สำเร็จ</h1>
    <p className="text-sm">
      อาจเป็นเพราะการเชื่อมต่อขัดข้อง หรือระบบเพิ่งอัปเดตเป็นเวอร์ชันใหม่
      กรุณาโหลดหน้าใหม่แล้วลองอีกครั้ง
    </p>
    <Button onClick={() => window.location.reload()}>โหลดหน้าใหม่</Button>
  </section>
);
