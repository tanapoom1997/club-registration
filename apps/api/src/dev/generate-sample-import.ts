import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SAMPLE_ADVISORS,
  SAMPLE_CLUBS,
  SAMPLE_STUDENTS,
  buildSampleImportWorkbooks,
} from './sample-import.js';

// samples/ at the repo root (same depth from src/dev and dist/dev). It is gitignored: the files
// are fictional, but committing any .xlsx outside templates/ is what a real student list would
// look like, so they are regenerated instead. Real school files live outside the repo.
const SAMPLES_DIR = fileURLToPath(new URL('../../../../samples/', import.meta.url));

if (process.env.NODE_ENV === 'production') {
  console.error('generate-sample-import refuses to run with NODE_ENV=production');
  process.exitCode = 1;
} else {
  await mkdir(SAMPLES_DIR, { recursive: true });
  const workbooks = await buildSampleImportWorkbooks();
  await Promise.all(
    workbooks.map(
      async ({ filename, bytes }) => await writeFile(join(SAMPLES_DIR, filename), bytes),
    ),
  );
  console.log(`Fictional sample import files (gitignored) in ${SAMPLES_DIR}:`);
  workbooks.forEach(({ filename }) => console.log(`  ${filename}`));
  console.log(
    `students=${SAMPLE_STUDENTS.length} clubRows=${SAMPLE_CLUBS.length} advisors=${SAMPLE_ADVISORS.length}`,
  );
}
