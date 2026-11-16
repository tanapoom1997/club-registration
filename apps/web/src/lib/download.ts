// Long enough for every browser to start reading the blob; FileSaver.js waits far longer, but
// here the blob holds live passwords and should not stay reachable from the page.
const REVOKE_DELAY_MS = 1_000;

// Hands a blob to the browser as a download.
export const saveFile = (file: Blob, filename: string): void => {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
};
