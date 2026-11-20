import { configure } from '@testing-library/react';

// Every page loads its own chunk with React.lazy and then its data, so a test's first findBy
// waits for an import and a query. On a CI runner under coverage instrumentation that has taken
// over the 1-second default (MyRegistrationPage, 1.2–1.8 s), failing a test with the page still
// on "กำลังโหลด…". A longer wait changes no assertion: findBy still returns as soon as it matches,
// and queryBy/getBy checks of what must not appear are unaffected.
configure({ asyncUtilTimeout: 5_000 });
