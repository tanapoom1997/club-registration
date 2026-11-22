type XlsxFilePickerProps = {
  id: string;
  accept: string;
  file: File | undefined;
  onChange: (file: File | undefined) => void;
};

const formatSize = (bytes: number): string =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024)).toLocaleString('th-TH')} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

// The browser's own file button speaks the browser's language ("Choose File", "No file chosen"),
// so the real input is laid transparent over a box in Thai. It is still the native input under
// the pointer and in the tab order: a click, a tap, a keyboard press and a file dropped on the box
// all reach it, and a screen reader hears the input itself (named by the page's <label>), which is
// why the Thai text over it is hidden from them rather than said twice.
export const XlsxFilePicker = ({ id, accept, file, onChange }: XlsxFilePickerProps) => (
  <div className="relative flex min-h-16 items-center gap-3 rounded-xl border border-dashed border-input bg-card p-3 transition-colors focus-within:border-primary focus-within:ring-4 focus-within:ring-primary/15 hover:border-primary/50 hover:bg-primary-soft/50">
    <input
      id={id}
      type="file"
      accept={accept}
      className="absolute inset-0 size-full cursor-pointer opacity-0"
      onChange={(event) => onChange(event.target.files?.[0])}
    />
    <span
      aria-hidden="true"
      className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary-soft text-primary"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="size-5"
      >
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
        <path d="M14 3v5h5" />
        <path d="M12 18v-6" />
        <path d="m9 15 3-3 3 3" />
      </svg>
    </span>
    <span aria-hidden="true" className="min-w-0 flex-1 text-sm">
      {file ? (
        <>
          <span className="block truncate font-medium">{file.name}</span>
          <span className="block text-xs text-muted-foreground">
            {formatSize(file.size)} · กดเพื่อเปลี่ยนไฟล์
          </span>
        </>
      ) : (
        <>
          <span className="block font-medium text-primary">เลือกไฟล์</span>
          <span className="block text-xs text-muted-foreground">กดเพื่อเลือก หรือลากไฟล์มาวางที่นี่</span>
        </>
      )}
    </span>
  </div>
);
