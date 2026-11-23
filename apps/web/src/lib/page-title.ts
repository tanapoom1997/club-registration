import { useEffect } from 'react';

export const APP_TITLE = 'ลงทะเบียนชุมนุม';

// The page first, so tabs, the history list and bookmarks tell pages apart where they cut the
// title short, and a screen reader hears it when the page opens (WCAG 2.4.2).
export const pageTitle = (page: string | undefined): string =>
  page === undefined ? APP_TITLE : `${page} · ${APP_TITLE}`;

export const useDocumentTitle = (page: string | undefined) => {
  useEffect(() => {
    document.title = pageTitle(page);
  }, [page]);
};
