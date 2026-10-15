import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { CalendarDays, Check, Copy, Download, ExternalLink, Loader2, Play, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';

type Flag = 'Yes' | 'No' | '';

type SummaryRow = {
  network: string;
  daypart: string;
  program: string;
  dow_array: number[];
  start_time: string;
  end_time: string;
  telecast_count: number | null;
  duration: number | null;
  demo_p2_plus_aa: number | null;
  demo_p25_54_aa: number | null;
  daypart_type: 'Weekday' | 'Weekend';
  saved_flag: string | null;
  last_month_flag: string | null;
};

type Row = SummaryRow & { flag: Flag };

type Generated = {
  month: string;
  year: number;
  month_num: number;
  month_start: string;
  month_end: string;
  period_start: string;
  period_end: string;
  custom_range: boolean;
  previous_month: string;
  function: string;
  table: string;
  rows: SummaryRow[];
  saved_rows_not_in_summary: number;
};

type MonthOption = { label: string; start: string; end: string; saved_rows: number };
type DateRange = { start: string; end: string };
type UploadResult = { month: string; table: string; user: string; rows: number; inserted: number; updated: number; unchanged: number };

const API = '/api/flags';
const BOX = 'flex h-10 items-center gap-2 rounded-lg border border-input bg-background px-3 text-sm';

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.detail) detail = String(body.detail);
    } catch {
      // keep the status text
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

const fmtDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtNum = (v: number | null) => (v === null || v === undefined ? '—' : v.toLocaleString('en-US'));
const asFlag = (v: string | null): Flag => (v === 'Yes' || v === 'No' ? v : '');
const rowKey = (r: SummaryRow) => `${r.network}|${r.daypart}|${r.program}|${r.start_time}|${r.end_time}`;

const DAY_NAMES: Record<string, string> = {
  '1,2,3,4,5': 'M-F',
  '6,7': 'Sa-Su',
  '7,1,2,3,4': 'Su-Th',
  '2,3,4,5': 'Tu-F',
  '1': 'M',
};
const DAY_SHORT = ['', 'M', 'Tu', 'W', 'Th', 'F', 'Sa', 'Su'];
const fmtDays = (d: number[]) => DAY_NAMES[d.join(',')] ?? d.map((x) => DAY_SHORT[x] ?? x).join(' ');

function status(r: Row): 'New' | 'Changed' | 'Saved' {
  if (r.saved_flag === null) return 'New';
  return r.flag === asFlag(r.saved_flag) ? 'Saved' : 'Changed';
}

function downloadCsv(name: string, rows: Row[], year: number, month: number) {
  const header = ['year', 'month', 'network', 'daypart', 'program', 'daypart_type', 'dow_array', 'start_time', 'end_time', 'flag'];
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [
    header.join(','),
    ...rows.map((r) =>
      [year, month, r.network, r.daypart, r.program, r.daypart_type, `[${r.dow_array.join(' ')}]`, r.start_time, r.end_time, r.flag]
        .map(cell)
        .join(','),
    ),
  ];
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function FlagTableUpdatePage() {
  const [months, setMonths] = useState<MonthOption[]>([]);
  const [month, setMonth] = useState('');
  const [range, setRange] = useState<DateRange | null>(null);
  const [gen, setGen] = useState<Generated | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [genieUrl, setGenieUrl] = useState<string | null>(null);
  const [network, setNetwork] = useState('all');
  const [dayType, setDayType] = useState('all');
  const [emptyOnly, setEmptyOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [lastUpload, setLastUpload] = useState<UploadResult | null>(null);

  useEffect(() => {
    fetchJson<{ genie_url: string | null }>(`${API}/config`)
      .then((r) => setGenieUrl(r.genie_url))
      .catch(() => setGenieUrl(null));
    fetchJson<{ months: MonthOption[] }>(`${API}/months`)
      .then((r) => {
        setMonths(r.months);
        if (r.months.length) setMonth(r.months[0].label);
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  const full = months.find((m) => m.label === month);
  const shown = range ?? (full ? { start: full.start, end: full.end } : undefined);
  const isCustom = range !== null;

  // A new month or new dates means the table on screen no longer matches the selection.
  const clearTable = () => {
    setGen(null);
    setRows([]);
    setLastUpload(null);
  };

  const changeDate = (which: 'start' | 'end', value: string) => {
    if (!full || !value) return;
    const next = { start: shown?.start ?? full.start, end: shown?.end ?? full.end, [which]: value };
    if (next.start > next.end || next.start < full.start || next.end > full.end) {
      toast.error(`Pick dates between ${fmtDate(full.start)} and ${fmtDate(full.end)}, start before end.`);
      return;
    }
    setRange(next.start === full.start && next.end === full.end ? null : next);
    clearTable();
  };

  const generate = async () => {
    setLoading(true);
    setError(null);
    setLastUpload(null);
    try {
      const dates = range ? `&start=${range.start}&end=${range.end}` : '';
      const result = await fetchJson<Generated>(`${API}/generate?month=${encodeURIComponent(month)}${dates}`);
      setGen(result);
      setRows(result.rows.map((r) => ({ ...r, flag: asFlag(r.saved_flag) })));
      setNetwork('all');
      setDayType('all');
      setEmptyOnly(false);
      setSearch('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const visible = useMemo(() => {
    const q = search.trim().toUpperCase();
    return rows.filter(
      (r) =>
        (network === 'all' || r.network === network) &&
        (dayType === 'all' || r.daypart_type === dayType) &&
        (!emptyOnly || r.flag === '') &&
        (!q || r.program.toUpperCase().includes(q) || r.daypart.toUpperCase().includes(q)),
    );
  }, [rows, network, dayType, emptyOnly, search]);

  const counts = useMemo(() => {
    const c = { Yes: 0, No: 0, empty: 0, New: 0, Changed: 0, Saved: 0 };
    for (const r of rows) {
      if (r.flag === '') c.empty += 1;
      else c[r.flag] += 1;
      c[status(r)] += 1;
    }
    return c;
  }, [rows]);

  const networks = useMemo(() => Array.from(new Set(rows.map((r) => r.network))).sort(), [rows]);

  const setFlag = (key: string, flag: Flag) => setRows((rs) => rs.map((r) => (rowKey(r) === key ? { ...r, flag } : r)));

  const setShown = (flag: Flag) => {
    const keys = new Set(visible.map(rowKey));
    setRows((rs) => rs.map((r) => (keys.has(rowKey(r)) ? { ...r, flag } : r)));
  };

  const copyLastMonth = () => {
    let filled = 0;
    const next = rows.map((r) => {
      const last = asFlag(r.last_month_flag);
      if (r.flag === '' && last !== '') {
        filled += 1;
        return { ...r, flag: last };
      }
      return r;
    });
    setRows(next);
    toast.success(`Filled ${filled} empty flags from ${gen?.previous_month ?? 'last month'}`);
  };

  const runUpload = async () => {
    setConfirmOpen(false);
    setUploading(true);
    try {
      const payload = rows.map(({ network, daypart, program, daypart_type, start_time, end_time, flag, dow_array }) => ({
        network,
        daypart,
        program,
        daypart_type,
        start_time,
        end_time,
        flag,
        dow_array,
      }));
      const result = await fetchJson<UploadResult>(`${API}/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ month, rows: payload, ...(range ? { start: range.start, end: range.end } : {}) }),
      });
      setLastUpload(result);
      toast.success(`${result.month} flag table updated: ${result.inserted} added, ${result.updated} changed`);
      // Saved flags now equal what is on screen.
      setRows((rs) => rs.map((r) => ({ ...r, saved_flag: r.flag })));
      setMonths((ms) => ms.map((m) => (m.label === month ? { ...m, saved_rows: m.saved_rows + result.inserted } : m)));
    } catch (e) {
      toast.error(`Upload failed: ${(e as Error).message}`);
    } finally {
      setUploading(false);
    }
  };

  const busy = loading || uploading;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4 md:p-6">
      <div>
        <h1 className="font-semibold text-2xl">Flag Table Update</h1>
        <p className="mt-1 text-muted-foreground text-sm">
          Generate the month's program slots, mark each one Yes or No, then upload. The Press Release and Historical Update
          read only the Yes rows.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="flag-month" className={BOX}>
          <span className="text-muted-foreground">Month:</span>
          <select
            id="flag-month"
            className="cursor-pointer bg-transparent font-medium focus-visible:outline-hidden"
            value={month}
            disabled={busy || months.length === 0}
            onChange={(e) => {
              setMonth(e.target.value);
              setRange(null);
              clearTable();
            }}
          >
            {months.map((m) => (
              <option key={m.label} value={m.label}>
                {m.label}
                {m.saved_rows ? ` (${m.saved_rows} saved)` : ''}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor="flag-start" className={cn(BOX, isCustom && 'border-primary')}>
          <CalendarDays className="size-4 text-muted-foreground" />
          <span className="text-muted-foreground">Start date:</span>
          <input
            id="flag-start"
            type="date"
            className="cursor-pointer bg-transparent font-medium focus-visible:outline-hidden"
            value={shown?.start ?? ''}
            min={full?.start}
            max={shown?.end ?? full?.end}
            disabled={!full || busy}
            onChange={(e) => changeDate('start', e.target.value)}
          />
        </label>
        <label htmlFor="flag-end" className={cn(BOX, isCustom && 'border-primary')}>
          <CalendarDays className="size-4 text-muted-foreground" />
          <span className="text-muted-foreground">End date:</span>
          <input
            id="flag-end"
            type="date"
            className="cursor-pointer bg-transparent font-medium focus-visible:outline-hidden"
            value={shown?.end ?? ''}
            min={shown?.start ?? full?.start}
            max={full?.end}
            disabled={!full || busy}
            onChange={(e) => changeDate('end', e.target.value)}
          />
        </label>
        <Button type="button" className="h-10" disabled={!month || busy} onClick={generate}>
          {loading ? <Loader2 className="animate-spin" /> : <Play />}
          {gen ? 'Generate again' : 'Generate table'}
        </Button>
        {genieUrl && (
          <a
            href={genieUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-input px-3 text-sm hover:bg-muted"
          >
            <ExternalLink className="size-4" />
            Open in Genie
          </a>
        )}
        <div className="ml-auto">
          <Button
            type="button"
            variant="primary"
            className="h-10"
            disabled={!gen || busy || rows.length === 0 || counts.empty > 0}
            title={counts.empty > 0 ? `${counts.empty} rows still have no flag` : undefined}
            onClick={() => setConfirmOpen(true)}
          >
            {uploading ? <Loader2 className="animate-spin" /> : <Upload />}
            {uploading ? 'Uploading…' : 'Upload table'}
          </Button>
        </div>
      </div>

      {lastUpload && (
        <div className="flex items-center gap-2 rounded-lg border border-green-300 bg-green-50 px-3 py-2 text-green-800 text-sm dark:border-green-900 dark:bg-green-950/30 dark:text-green-300">
          <Check className="size-4 shrink-0" />
          {lastUpload.month} flag table updated by {lastUpload.user}: {lastUpload.inserted} added, {lastUpload.updated} changed,{' '}
          {lastUpload.unchanged} unchanged.
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive text-sm">{error}</div>
      )}

      {!gen && !loading && !error && (
        <div className="flex flex-1 items-center justify-center">
          <p className="max-w-md text-center text-muted-foreground text-sm">
            Pick a month and press <span className="font-medium">Generate table</span>. Flags already saved for that month are
            filled in; the rest start empty.
          </p>
        </div>
      )}

      {loading && (
        <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="size-4 animate-spin" />
          Building the {month} program slots from the Nielsen data…
        </div>
      )}

      {gen && !loading && (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          {gen.custom_range && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900 text-sm dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
              Slots and numbers cover {fmtDate(gen.period_start)} – {fmtDate(gen.period_end)} only, not the full broadcast
              month ({fmtDate(gen.month_start)} – {fmtDate(gen.month_end)}).
            </div>
          )}
          {gen.saved_rows_not_in_summary > 0 && (
            <div className="rounded-lg border px-3 py-2 text-muted-foreground text-sm">
              {gen.saved_rows_not_in_summary} rows already in the flag table for {gen.month} are not in this list. Upload leaves
              them as they are.
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-md bg-green-100 px-2 py-1 font-medium text-green-800 text-xs dark:bg-green-950/40 dark:text-green-300">
              Yes {counts.Yes}
            </span>
            <span className="rounded-md bg-muted px-2 py-1 font-medium text-xs">No {counts.No}</span>
            <span
              className={cn(
                'rounded-md px-2 py-1 font-medium text-xs',
                counts.empty ? 'bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200' : 'bg-muted',
              )}
            >
              Empty {counts.empty}
            </span>
            <span className="text-muted-foreground text-xs">
              · {counts.New} new · {counts.Changed} changed · {counts.Saved} saved
            </span>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Button type="button" className="h-9" disabled={busy} onClick={copyLastMonth}>
                <Copy />
                Copy flags from {gen.previous_month}
              </Button>
              <Button
                type="button"
                className="h-9"
                onClick={() => downloadCsv(`flag_table_${gen.month}.csv`, rows, gen.year, gen.month_num)}
              >
                <Download />
                Download (CSV)
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              aria-label="Search program or daypart"
              placeholder="Search program or daypart"
              className="h-9 min-w-64 rounded-lg border border-input bg-background px-3 text-sm"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              aria-label="Filter by network"
              className="h-9 cursor-pointer rounded-lg border border-input bg-background px-3 text-sm"
              value={network}
              onChange={(e) => setNetwork(e.target.value)}
            >
              <option value="all">All networks</option>
              {networks.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <select
              aria-label="Filter by daypart type"
              className="h-9 cursor-pointer rounded-lg border border-input bg-background px-3 text-sm"
              value={dayType}
              onChange={(e) => setDayType(e.target.value)}
            >
              <option value="all">Weekday and weekend</option>
              <option value="Weekday">Weekday</option>
              <option value="Weekend">Weekend</option>
            </select>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input type="checkbox" checked={emptyOnly} onChange={(e) => setEmptyOnly(e.target.checked)} />
              Empty flags only
            </label>
            <div className="ml-auto flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Set the {visible.length} shown rows to</span>
              <Button type="button" className="h-9" disabled={busy || visible.length === 0} onClick={() => setShown('Yes')}>
                Yes
              </Button>
              <Button type="button" className="h-9" disabled={busy || visible.length === 0} onClick={() => setShown('No')}>
                No
              </Button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto rounded-lg border">
            <table className="w-full min-w-[1100px] border-collapse text-sm">
              <thead className="sticky top-0 bg-muted text-left text-xs">
                <tr>
                  <th className="px-3 py-2.5 font-semibold">Network</th>
                  <th className="px-3 py-2.5 font-semibold">Daypart</th>
                  <th className="px-3 py-2.5 font-semibold">Program</th>
                  <th className="px-3 py-2.5 font-semibold">Days</th>
                  <th className="px-3 py-2.5 font-semibold">Start</th>
                  <th className="px-3 py-2.5 font-semibold">End</th>
                  <th className="px-3 py-2.5 text-right font-semibold">TCs</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Dur</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Total 2+ AA</th>
                  <th className="px-3 py-2.5 text-right font-semibold">A25-54 AA</th>
                  <th className="px-3 py-2.5 font-semibold">Flag</th>
                  <th className="px-3 py-2.5 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => {
                  const k = rowKey(r);
                  const st = status(r);
                  return (
                    <tr key={k} className={cn('border-t', r.flag === '' && 'bg-amber-50 dark:bg-amber-950/20')}>
                      <td className="px-3 py-2">{r.network}</td>
                      <td className="whitespace-nowrap px-3 py-2">{r.daypart}</td>
                      <td className="px-3 py-2">{r.program}</td>
                      <td className="whitespace-nowrap px-3 py-2">{fmtDays(r.dow_array)}</td>
                      <td className="whitespace-nowrap px-3 py-2">{r.start_time}</td>
                      <td className="whitespace-nowrap px-3 py-2">{r.end_time}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtNum(r.telecast_count)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtNum(r.duration)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtNum(r.demo_p2_plus_aa)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtNum(r.demo_p25_54_aa)}</td>
                      <td className="px-3 py-2">
                        <select
                          aria-label={`Flag for ${r.program} in ${r.daypart}`}
                          className={cn(
                            'h-8 cursor-pointer rounded-md border bg-background px-2 text-sm',
                            r.flag === '' && 'border-amber-400',
                          )}
                          value={r.flag}
                          disabled={uploading}
                          onChange={(e) => setFlag(k, e.target.value as Flag)}
                        >
                          <option value="">—</option>
                          <option value="Yes">Yes</option>
                          <option value="No">No</option>
                        </select>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-xs">
                        <span
                          className={cn(
                            st === 'New' && 'text-primary',
                            st === 'Changed' && 'font-medium text-amber-700 dark:text-amber-300',
                            st === 'Saved' && 'text-muted-foreground',
                          )}
                        >
                          {st}
                        </span>
                      </td>
                    </tr>
                  );
                })}
                {visible.length === 0 && (
                  <tr>
                    <td colSpan={12} className="px-3 py-6 text-center text-muted-foreground">
                      No rows match these filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <p className="text-muted-foreground text-sm">
            Showing {visible.length} of {rows.length} rows
          </p>
          <p className="text-muted-foreground text-xs italic">
            source: {gen.function} · writes to: {gen.table}
          </p>
        </div>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Upload the {month} flag table?</AlertDialogTitle>
            <AlertDialogDescription>
              {counts.New + counts.Changed === 0
                ? `The flag table already matches what is shown (${counts.Saved} rows). Uploading will change nothing.`
                : `${counts.New} new rows will be added and ${counts.Changed} saved flags will be changed. ${counts.Saved} rows are unchanged.`}{' '}
              {counts.Yes} rows are Yes and {counts.No} are No. Rows already in the table but not in this list are left as they
              are.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={runUpload}>Upload table</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
