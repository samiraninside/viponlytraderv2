/** IST clock and NSE / BSE / MCX sessions. All times IST (UTC+05:30), no DST in India. */
import { ENTRY_WINDOW, SQUARE_OFF } from "./config";

export const IST_OFFSET_MS = 330 * 60 * 1000;

export interface IST { date: string; hhmm: string; mins: number; dow: number; epoch: number }

export function ist(epochMs = Date.now()): IST {
  const d = new Date(epochMs + IST_OFFSET_MS);
  const date = d.toISOString().slice(0, 10);
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return { date, hhmm: d.toISOString().slice(11, 16), mins, dow: d.getUTCDay(), epoch: epochMs };
}

export const toMins = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
export const fromMins = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
/** epoch seconds of an IST date + minutes */
export const istEpoch = (date: string, mins: number) => Date.parse(`${date}T00:00:00Z`) / 1000 - IST_OFFSET_MS / 1000 + mins * 60;

/** NSE/BSE 2026 weekday trading holidays (equity + equity derivatives). */
export const NSE_HOLIDAYS: Record<string, string> = {
  "2026-01-15": "Municipal Corporation Election (Maharashtra)", "2026-01-26": "Republic Day", "2026-03-03": "Holi",
  "2026-03-26": "Shri Ram Navami", "2026-03-31": "Shri Mahavir Jayanti", "2026-04-03": "Good Friday",
  "2026-04-14": "Dr. Baba Saheb Ambedkar Jayanti", "2026-05-01": "Maharashtra Day", "2026-05-28": "Bakri Id",
  "2026-06-26": "Muharram", "2026-09-14": "Ganesh Chaturthi", "2026-10-02": "Mahatma Gandhi Jayanti",
  "2026-10-20": "Dussehra", "2026-11-10": "Diwali Balipratipada", "2026-11-24": "Prakash Gurpurb Sri Guru Nanak Dev",
  "2026-12-25": "Christmas",
};
/** MCX 2026: [morningOpen, eveningOpen, name]. */
export const MCX_HOLIDAYS: Record<string, [boolean, boolean, string]> = {
  "2026-01-01": [true, false, "New Year Day"], "2026-01-15": [false, true, "Municipal Corporation Election"],
  "2026-01-26": [false, false, "Republic Day"], "2026-03-03": [false, true, "Holi"], "2026-03-26": [false, true, "Shri Ram Navami"],
  "2026-03-31": [false, true, "Shri Mahavir Jayanti"], "2026-04-03": [false, false, "Good Friday"],
  "2026-04-14": [false, true, "Ambedkar Jayanti"], "2026-05-01": [false, true, "Maharashtra Day"],
  "2026-05-28": [false, true, "Bakri Id"], "2026-06-26": [false, true, "Muharram"], "2026-09-14": [false, true, "Ganesh Chaturthi"],
  "2026-10-02": [false, false, "Mahatma Gandhi Jayanti"], "2026-10-20": [false, true, "Dussehra"],
  "2026-11-10": [false, true, "Diwali Balipratipada"], "2026-11-24": [false, true, "Guru Nanak Jayanti"],
  "2026-12-25": [false, false, "Christmas"],
};
/** Extra holidays you add later (e.g. the 2027 list when published): "NSE:2027-01-26", "MCX:2027-01-26". */
export const EXTRA_HOLIDAYS: string[] = [];
const KNOWN_YEARS = [2026];

export const yearKnown = (date: string) =>
  KNOWN_YEARS.includes(+date.slice(0, 4)) || EXTRA_HOLIDAYS.some((h) => h.slice(4, 8) === date.slice(0, 4));

const dow = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
const nthSunday = (y: number, m: number, n: number) => {
  const d = new Date(Date.UTC(y, m - 1, 1));
  d.setUTCDate(1 + ((7 - d.getUTCDay()) % 7) + 7 * (n - 1));
  return d.toISOString().slice(0, 10);
};
export const usDst = (date: string) => {
  const y = +date.slice(0, 4);
  return date >= nthSunday(y, 3, 2) && date < nthSunday(y, 11, 1);
};
export const mcxClose = (date: string) => (usDst(date) ? toMins("23:30") : toMins("23:55"));

export type Seg = "NSE_EQ" | "NSE_FNO" | "BSE_FNO" | "MCX_COMM" | "IDX_I";
export interface Session { start: number; end: number; label: string }

/** Sessions in minutes-of-day for a segment on a date. */
export function sessions(seg: Seg, date: string, opts: { expiringIndex?: boolean; fnoStock?: boolean } = {}): Session[] {
  if (seg === "MCX_COMM") {
    if (dow(date) === 0 || dow(date) === 6 || EXTRA_HOLIDAYS.includes(`MCX:${date}`)) return [];
    const [mo, eo] = MCX_HOLIDAYS[date] ?? [true, true];
    const out: Session[] = [];
    if (mo) out.push({ start: toMins("09:00"), end: toMins("17:00"), label: "MCX morning" });
    if (eo) out.push({ start: toMins("17:00"), end: mcxClose(date), label: "MCX evening" });
    return out;
  }
  if (date === "2026-02-01") return [{ start: toMins("09:15"), end: toMins("15:30"), label: "Budget session" }];
  if (dow(date) === 0 || dow(date) === 6 || NSE_HOLIDAYS[date] || EXTRA_HOLIDAYS.includes(`NSE:${date}`)) return [];
  if (seg === "NSE_FNO" || seg === "BSE_FNO") {
    let end = "15:30";
    if (date >= "2026-12-07") end = opts.expiringIndex ? "15:30" : "15:45";
    else if (date >= "2026-08-03") end = "15:40";
    return [{ start: toMins("09:15"), end: toMins(end), label: "F&O" }];
  }
  const end = opts.fnoStock && date >= "2026-08-03" && date < "2026-12-07" ? "15:15" : "15:30";
  return [{ start: toMins("09:15"), end: toMins(end), label: seg === "IDX_I" ? "Index" : "Cash" }];
}

export const isOpen = (seg: Seg, t: IST, o = {}) => sessions(seg, t.date, o).some((s) => t.mins >= s.start && t.mins < s.end);
export const tradingDay = (seg: Seg, date: string) => sessions(seg, date).length > 0;
export const holidayName = (seg: Seg, date: string) =>
  seg === "MCX_COMM" ? MCX_HOLIDAYS[date]?.[2] ?? null : NSE_HOLIDAYS[date] ?? null;

export function squareOff(seg: Seg, date: string, o = {}): number | null {
  const s = sessions(seg, date, o);
  if (!s.length) return null;
  const close = s[s.length - 1].end;
  if (seg === "MCX_COMM") return close - SQUARE_OFF.mcxMinutesBeforeClose;
  return Math.min(toMins(SQUARE_OFF.NSE), close - 5);
}

export function entryWindow(seg: Seg): [number, number] {
  const [a, b] = seg === "MCX_COMM" ? ENTRY_WINDOW.MCX : ENTRY_WINDOW.NSE;
  return [toMins(a), toMins(b)];
}

export function addDays(date: string, n: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function nextTradingDay(seg: Seg, date: string, n = 1) {
  let d = date;
  for (let k = 0; k < n; ) { d = addDays(d, 1); if (tradingDay(seg, d)) k++; }
  return d;
}
export function tradingDaysBetween(seg: Seg, from: string, to: string) {
  let n = 0, d = from;
  while (d < to) { d = addDays(d, 1); if (tradingDay(seg, d)) n++; }
  return n;
}
