// Asia/Bangkok has been a fixed UTC+7 without daylight saving since 1920, so a constant offset is
// exact and avoids needing a timezone library to turn a typed local time into an instant.
const BANGKOK_OFFSET = '+07:00';
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
export const THAI_TIME_ZONE = 'Asia/Bangkok';

const DATETIME_LOCAL_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

const displayFormat = new Intl.DateTimeFormat('th-TH', {
  timeZone: THAI_TIME_ZONE,
  dateStyle: 'medium',
  timeStyle: 'short',
});

const dateFormat = new Intl.DateTimeFormat('th-TH', {
  timeZone: THAI_TIME_ZONE,
  dateStyle: 'medium',
});

const timeFormat = new Intl.DateTimeFormat('th-TH', {
  timeZone: THAI_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

// Thai date and time (Buddhist year), whatever timezone the viewer's computer is set to.
export const formatThaiDateTime = (iso: string): string => displayFormat.format(new Date(iso));

// Thai date only (Buddhist year), for a narrow column that puts the time on its own line.
export const formatThaiDate = (iso: string): string => dateFormat.format(new Date(iso));

// Thai time of day only (HH:MM), for a deadline within the same day.
export const formatThaiTime = (iso: string): string => timeFormat.format(new Date(iso));

// A <input type="datetime-local"> value typed as Thai time → UTC ISO string for the API.
// undefined for an empty or malformed value, which the form reports as a validation error.
export const thaiInputToIso = (value: string): string | undefined => {
  if (!DATETIME_LOCAL_PATTERN.test(value)) return undefined;
  const withSeconds = value.length === 16 ? `${value}:00` : value;
  const instant = new Date(`${withSeconds}${BANGKOK_OFFSET}`);
  return Number.isNaN(instant.getTime()) ? undefined : instant.toISOString();
};

// UTC ISO string from the API → <input type="datetime-local"> value in Thai time.
export const isoToThaiInput = (iso: string): string =>
  new Date(Date.parse(iso) + BANGKOK_OFFSET_MS).toISOString().slice(0, 16);
