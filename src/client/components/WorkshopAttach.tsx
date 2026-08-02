import { useRef } from 'react';

/**
 * "Add files for the agent to analyze, dissect, or learn from" — the Workshop
 * composer's attach controls, split out of Workshop.tsx to keep that file
 * about the conversation, not file plumbing. Mirrors Toile's design: a
 * screenshot is shown to the agent with the Read tool (never lands in the
 * project); a doc/code file/.zip is dropped straight into the project root
 * (a zip is extracted).
 *
 * Two different paths, because size differs by two orders of magnitude:
 * screenshots are small (a UI mockup) and travel inline as base64 in the
 * message itself. Files can be large (a data export, an old app's zip), so
 * they're staged to the server immediately on pick, via a real multipart
 * upload — the browser never holds the whole thing as a base64 string, and
 * neither does the server (see build/uploads.ts). The message then just
 * carries the small upload id it got back.
 */

export type PendingImage = { mime: string; dataBase64: string; previewUrl: string; name: string };
export type PendingFile = { id: string; name: string; size: number };

export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
export const ALLOWED_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const MAX_FILES = 5;

function readImage(file: File): Promise<PendingImage> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const url = r.result as string;
      const comma = url.indexOf(',');
      resolve({ mime: url.slice(5, url.indexOf(';')), dataBase64: url.slice(comma + 1), previewUrl: url, name: file.name || 'image' });
    };
    r.onerror = () => reject(new Error('read failed'));
    r.readAsDataURL(file);
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Read and validate picked/pasted image files, reporting the first problem via onError. */
export async function addImages(
  picked: FileList | File[],
  current: PendingImage[],
  onChange: (v: PendingImage[]) => void,
  onError: (msg: string) => void,
): Promise<void> {
  const room = MAX_IMAGES - current.length;
  if (room <= 0) {
    onError(`At most ${MAX_IMAGES} images per message.`);
    return;
  }
  const accepted: File[] = [];
  for (const file of Array.from(picked).slice(0, room)) {
    if (!ALLOWED_IMAGE_MIMES.includes(file.type)) onError('Only PNG, JPEG, WebP, or GIF images.');
    else if (file.size > MAX_IMAGE_BYTES) onError(`${file.name} is over ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))}MB.`);
    else accepted.push(file);
  }
  if (!accepted.length) return;
  try {
    onChange([...current, ...(await Promise.all(accepted.map(readImage)))]);
  } catch {
    onError('Could not read that image.');
  }
}

/**
 * Stage picked files with the server one at a time (each a real multipart
 * upload — no size held in browser memory as text), adding each to the
 * pending list as its upload completes. A file that fails to upload (too
 * big, network hiccup) is reported and simply skipped, not blocking the rest.
 */
export async function addDocs(
  picked: FileList | File[],
  current: PendingFile[],
  onChange: (v: PendingFile[]) => void,
  onError: (msg: string) => void,
  uploadUrl: string,
): Promise<void> {
  const room = MAX_FILES - current.length;
  if (room <= 0) {
    onError(`At most ${MAX_FILES} files per message.`);
    return;
  }
  let list = current;
  for (const file of Array.from(picked).slice(0, room)) {
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(uploadUrl, { method: 'POST', body: form, credentials: 'include' });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        onError(body?.error ?? `Could not attach ${file.name}.`);
        continue;
      }
      const staged = (await res.json()) as { id: string; name: string; size: number };
      list = [...list, staged];
      onChange(list);
    } catch {
      onError(`Could not attach ${file.name} — check the connection and try again.`);
    }
  }
}

/** Any images pasted into an input/textarea, or an empty array. */
export function pastedImageFiles(e: React.ClipboardEvent): File[] {
  return Array.from(e.clipboardData.items)
    .filter((it) => it.type.startsWith('image/'))
    .map((it) => it.getAsFile())
    .filter((f): f is File => f !== null);
}

/** The pending chips (files, then image thumbnails) shown above the composer input. */
export function PendingChips({
  images,
  onImagesChange,
  files,
  onFilesChange,
}: {
  images: PendingImage[];
  onImagesChange: (v: PendingImage[]) => void;
  files: PendingFile[];
  onFilesChange: (v: PendingFile[]) => void;
}) {
  if (images.length === 0 && files.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 pb-2">
      {files.map((file, i) => (
        <div key={file.id} className="flex max-w-full items-center gap-2 rounded-inset border border-hairline bg-panel-soft py-1 pl-2 pr-1">
          <FileGlyph />
          <span className="min-w-0 max-w-[10rem] truncate text-meta text-ink">{file.name}</span>
          <span className="shrink-0 text-meta text-ink-quiet">{formatSize(file.size)}</span>
          <button
            type="button"
            onClick={() => onFilesChange(files.filter((_, j) => j !== i))}
            aria-label={`Remove ${file.name}`}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-meta text-ink-quiet hover:bg-panel hover:text-ink"
          >
            ✕
          </button>
        </div>
      ))}
      {images.map((img, i) => (
        <div key={i} className="relative">
          <img src={img.previewUrl} alt={img.name} className="h-12 w-12 rounded-inset border border-hairline object-cover" />
          <button
            type="button"
            onClick={() => onImagesChange(images.filter((_, j) => j !== i))}
            aria-label={`Remove ${img.name}`}
            className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-hairline bg-panel text-meta text-ink"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

/** The two small attach buttons (screenshot, file) that sit beside the composer input. */
export function AttachButtons({
  images,
  onImagesChange,
  files,
  onFilesChange,
  uploadUrl,
  uploading,
  onUploadingChange,
  disabled,
  onError,
}: {
  images: PendingImage[];
  onImagesChange: (v: PendingImage[]) => void;
  files: PendingFile[];
  onFilesChange: (v: PendingFile[]) => void;
  /** Where a picked file is staged — `/api/projects/:id/workshop/uploads`. */
  uploadUrl: string;
  /** True while a file is mid-upload — the composer disables sending so a not-yet-issued id can't be referenced. */
  uploading: boolean;
  onUploadingChange: (v: boolean) => void;
  disabled: boolean;
  onError: (msg: string) => void;
}) {
  const imageInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  return (
    <>
      <input
        ref={imageInput}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) void addImages(e.target.files, images, onImagesChange, onError);
          e.target.value = '';
        }}
      />
      <input
        ref={fileInput}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const picked = e.target.files;
          e.target.value = '';
          if (!picked) return;
          onUploadingChange(true);
          void addDocs(picked, files, onFilesChange, onError, uploadUrl).finally(() => onUploadingChange(false));
        }}
      />
      <button
        type="button"
        onClick={() => imageInput.current?.click()}
        disabled={disabled || images.length >= MAX_IMAGES}
        aria-label="Attach a screenshot"
        title="Attach a screenshot — the agent looks at it with the Read tool"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-inset text-ink-quiet transition-colors hover:bg-panel-soft hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright disabled:opacity-40"
      >
        <ImageGlyph />
      </button>
      <button
        type="button"
        onClick={() => fileInput.current?.click()}
        disabled={disabled || uploading || files.length >= MAX_FILES}
        aria-label="Attach files"
        title="Attach code, docs, or a .zip — dropped into the project for the agent to work from"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-inset text-ink-quiet transition-colors hover:bg-panel-soft hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-action-bright disabled:opacity-40"
      >
        {uploading ? <SpinnerGlyph /> : <PaperclipGlyph />}
      </button>
    </>
  );
}

function FileGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

function ImageGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="M21 15l-5-5L5 21" />
    </svg>
  );
}

function PaperclipGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21.44 11.05l-9.19 9.19a5 5 0 0 1-7.07-7.07l9.19-9.19a3 3 0 0 1 4.24 4.24l-9.19 9.19a1 1 0 0 1-1.41-1.41l8.49-8.49" />
    </svg>
  );
}

function SpinnerGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className="animate-spin" aria-hidden>
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  );
}
