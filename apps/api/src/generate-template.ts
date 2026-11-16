import { writeFile } from 'node:fs/promises';
import { buildImportTemplate, IMPORT_TEMPLATE_PATH } from './import/template.js';

// Rewrites templates/import-template.xlsx from the column definitions in packages/shared. Run it
// after changing a column, then commit the file; a test fails while the two disagree.
await writeFile(IMPORT_TEMPLATE_PATH, await buildImportTemplate());
console.log(`wrote ${IMPORT_TEMPLATE_PATH}`);
