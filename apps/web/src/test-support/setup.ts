import { configure } from '@testing-library/react';

// Every page loads its own chunk with React.lazy and then its data, so a test's first findBy
// waits for an import and a query. On a CI runner under coverage instrumentation that has taken
// over the 1-second default (MyRegistrationPage, 1.2–1.8 s), failing a test with the page still
// on "กำลังโหลด…". A longer wait changes no assertion: findBy still returns as soon as it matches,
// and queryBy/getBy checks of what must not appear are unaffected.
configure({ asyncUtilTimeout: 5_000 });

// jsdom has no layout, so it has neither scrollIntoView nor matchMedia. Panels that open away from
// their button scroll themselves into view (lib/panel-focus.ts); no-op stand-ins let every page
// render, and a test that checks the scroll or the reduced-motion preference spies on them
// (restoreMocks puts these back after each test).
Element.prototype.scrollIntoView = () => undefined;
window.matchMedia = (query: string): MediaQueryList => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => undefined,
  removeListener: () => undefined,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => false,
});
