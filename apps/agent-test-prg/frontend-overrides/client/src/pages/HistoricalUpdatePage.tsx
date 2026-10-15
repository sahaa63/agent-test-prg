import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ArrowUpDown, CalendarDays, Check, Download, Loader2, RotateCcw } from 'lucide-react';
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

type Status = 'New' | 'Changed' | 'Unchanged';

type Row = {
  Month: string;
  Network: string;
  Daypart: string;
  Program: string;
  Start: string;
  End: string;
  Demo: string;
  TCs: number | null;
  Dur: number | null;
  Impressions: number | null;
  status: Status;
};

type TableSnapshot = {
  table: string;
  rows: Row[];
  counts: Record<Status, number>;
  has_tcs: boolean;
};

type Snapshot = {
  month: string;
  month_start: string;
  month_end: string;
  period_start: string;
  period_end: string;
  custom_range: boolean;
  weekday: TableSnapshot;
  weekend: TableSnapshot;
};

type DateRange = { start: string; end: string };

type TableResult = { table: string; inserted: number; updated: number };

type UpdateResult = {
  month: string;
  user: string;
  inserted: number;
  updated: number;
  weekday: TableResult;
  weekend: TableResult;
  period_start: string;
  period_end: string;
  custom_range: boolean;
};

type SortKey = 'Network' | 'Daypart' | 'Program' | 'Demo' | 'TCs' | 'Dur' | 'Impressions';

const API = '/api/hist/program';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  return fetchJson<T>(`${API}${path}`, init);
}

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

const fmtNum = (v: number | null) => (v === null || v === undefined ? '—' : String(v));

const BOX = 'flex h-10 items-center gap-2 rounded-lg border border-input bg-background px-3 text-sm';

function downloadCsv(name: string, data: TableSnapshot) {
  const cols: (keyof Row)[] = ['Month', 'Network', 'Daypart', 'Program', 'Start', 'End', 'Demo'];
  if (data.has_tcs) cols.push('TCs');
  cols.push('Dur', 'Impressions');
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(','), ...data.rows.map((r) => cols.map((c) => cell(r[c])).join(','))];
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function SnapshotTable({ data, network }: { data: TableSnapshot; network: string }) {
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean } | null>(null);

  const rows = useMemo(() => {
    const filtered = data.rows.filter((r) => network === 'all' || r.Network === network);
    if (!sort) return filtered;
    const dir = sort.asc ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const x = a[sort.key];
      const y = b[sort.key];
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
      return String(x ?? '').localeCompare(String(y ?? '')) * dir;
    });
  }, [data.rows, network, sort]);

  const head = (label: string, key?: SortKey, right = false) => (
    <th className={cn('px-3 py-2.5 font-semibold', right && 'text-right')}>
      {key ? (
        <button
          type="button"
          className={cn('inline-flex cursor-pointer items-center gap-1', right && 'flex-row-reverse')}
          onClick={() => setSort((s) => (s?.key === key ? { key, asc: !s.asc } : { key, asc: true }))}
          title={`Sort by ${label}`}
        >
          {label}
          <ArrowUpDown className={cn('size-3.5', sort?.key === key ? 'text-primary' : 'text-muted-foreground')} />
        </button>
      ) : (
        label
      )}
    </th>
  );

  return (
    <>
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border">
        <table className="w-full min-w-[860px] border-collapse text-sm">
          <thead className="sticky top-0 bg-muted text-left text-xs">
            <tr>
              {head('Network', 'Network')}
              {head('Daypart', 'Daypart')}
              {head('Program', 'Program')}
              {head('Start')}
              {head('End')}
              {head('Demo', 'Demo')}
              {data.has_tcs && head('TCs', 'TCs', true)}
              {head('Dur', 'Dur', true)}
              {head('Impressions', 'Impressions', true)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.Network}|${r.Daypart}|${r.Program}|${r.Demo}`} className="border-t">
                <td className="px-3 py-2">{r.Network}</td>
                <td className="px-3 py-2">{r.Daypart}</td>
                <td className="px-3 py-2">{r.Program}</td>
                <td className="whitespace-nowrap px-3 py-2">{r.Start}</td>
                <td className="whitespace-nowrap px-3 py-2">{r.End}</td>
                <td className="whitespace-nowrap px-3 py-2">{r.Demo}</td>
                {data.has_tcs && <td className="px-3 py-2 text-right tabular-nums">{fmtNum(r.TCs)}</td>}
                <td className="px-3 py-2 text-right tabular-nums">{fmtNum(r.Dur)}</td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums">{fmtNum(r.Impressions)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-6 text-center text-muted-foreground">
                  No rows for this network.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-muted-foreground text-sm">
        Showing {rows.length} of {data.rows.length} rows
      </p>
      <p className="text-muted-foreground text-xs italic">writes to: {data.table}</p>
    </>
  );
}

function ProgramTab() {
  const [months, setMonths] = useState<string[]>([]);
  const [month, setMonth] = useState('');
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'weekday' | 'weekend'>('weekday');
  const [network, setNetwork] = useState('all');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<UpdateResult | null>(null);
  // Custom dates inside the month; null means the full broadcast month.
  const [range, setRange] = useState<DateRange | null>(null);
  // Full broadcast-month dates per month, known once that month has loaded.
  const [bounds, setBounds] = useState<Record<string, DateRange>>({});

  // Snapshots already fetched this visit, so switching back to a month is instant.
  const cache = useRef(new Map<string, Snapshot>());
  // Only the newest request may update the page; older ones are ignored when they return.
  const latest = useRef(0);

  const load = useCallback(async (m: string, r: DateRange | null, fresh = false) => {
    const id = ++latest.current;
    const key = `${m}|${r?.start ?? ''}|${r?.end ?? ''}`;
    const cached = fresh ? undefined : cache.current.get(key);
    setError(null);
    if (cached) {
      setSnap(cached);
      setLoading(false);
      return;
    }
    setSnap(null);
    setLoading(true);
    try {
      const dates = r ? `&start=${r.start}&end=${r.end}` : '';
      const result = await api<Snapshot>(`/snapshot?month=${encodeURIComponent(m)}${dates}`);
      cache.current.set(key, result);
      setBounds((b) => ({ ...b, [m]: { start: result.month_start, end: result.month_end } }));
      if (id === latest.current) setSnap(result);
    } catch (e) {
      if (id === latest.current) setError((e as Error).message);
    } finally {
      if (id === latest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    api<{ months: { label: string; start: string | null; end: string | null }[] }>('/months')
      .then((r) => {
        const labels = r.months.map((x) => x.label);
        setMonths(labels);
        // Month dates arrive with the list, so the date pickers work before any calculation finishes.
        const known: Record<string, DateRange> = {};
        for (const x of r.months) if (x.start && x.end) known[x.label] = { start: x.start, end: x.end };
        setBounds((b) => ({ ...known, ...b }));
        if (labels.length) setMonth(labels[0]);
        else setError('The program flag table has no months.');
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  useEffect(() => {
    if (month) {
      setLastUpdate(null);
      setNetwork('all');
      setRange(null);
      load(month, null);
    }
  }, [month, load]);

  const full = bounds[month];
  const shown = range ?? full;
  const isCustom = range !== null;

  const changeDate = (which: 'start' | 'end', value: string) => {
    if (!full || !value) return;
    const next = { start: shown?.start ?? full.start, end: shown?.end ?? full.end, [which]: value };
    if (next.start > next.end || next.start < full.start || next.end > full.end) {
      toast.error(`Pick dates between ${fmtDate(full.start)} and ${fmtDate(full.end)}, start before end.`);
      return;
    }
    const custom = next.start === full.start && next.end === full.end ? null : next;
    setRange(custom);
    setLastUpdate(null);
    load(month, custom);
  };

  const resetDates = () => {
    setRange(null);
    load(month, null);
  };

  const totals = useMemo(() => {
    if (!snap) return { added: 0, changed: 0, unchanged: 0 };
    const t = [snap.weekday, snap.weekend];
    return {
      added: t.reduce((n, x) => n + x.counts.New, 0),
      changed: t.reduce((n, x) => n + x.counts.Changed, 0),
      unchanged: t.reduce((n, x) => n + x.counts.Unchanged, 0),
    };
  }, [snap]);

  const networks = useMemo(
    () => (snap ? Array.from(new Set(snap[view].rows.map((r) => r.Network))).sort() : []),
    [snap, view],
  );

  const pending = totals.added + totals.changed;
  const busy = loading || updating;

  const runUpdate = async () => {
    setConfirmOpen(false);
    setUpdating(true);
    try {
      const result = await api<UpdateResult>('/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(range ? { month, start: range.start, end: range.end } : { month }),
      });
      setLastUpdate(result);
      toast.success(`${result.month} updated: ${result.inserted} added, ${result.updated} changed`);
      // The tables changed, so every remembered snapshot is out of date.
      cache.current.clear();
      await load(month, range, true);
    } catch (e) {
      toast.error(`Update failed: ${(e as Error).message}`);
    } finally {
      setUpdating(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="hist-month" className={BOX}>
          <span className="text-muted-foreground">Month:</span>
          <select
            id="hist-month"
            className="cursor-pointer bg-transparent font-medium focus-visible:outline-hidden"
            value={month}
            disabled={updating || months.length === 0}
            onChange={(e) => setMonth(e.target.value)}
          >
            {months.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor="hist-start" className={cn(BOX, isCustom && 'border-primary')}>
          <CalendarDays className="size-4 text-muted-foreground" />
          <span className="text-muted-foreground">Start date:</span>
          <input
            id="hist-start"
            type="date"
            className="cursor-pointer bg-transparent font-medium focus-visible:outline-hidden"
            value={shown?.start ?? ''}
            min={full?.start}
            max={shown?.end ?? full?.end}
            disabled={!full || updating}
            onChange={(e) => changeDate('start', e.target.value)}
          />
        </label>
        <label htmlFor="hist-end" className={cn(BOX, isCustom && 'border-primary')}>
          <CalendarDays className="size-4 text-muted-foreground" />
          <span className="text-muted-foreground">End date:</span>
          <input
            id="hist-end"
            type="date"
            className="cursor-pointer bg-transparent font-medium focus-visible:outline-hidden"
            value={shown?.end ?? ''}
            min={shown?.start ?? full?.start}
            max={full?.end}
            disabled={!full || updating}
            onChange={(e) => changeDate('end', e.target.value)}
          />
        </label>
        {isCustom && (
          <Button type="button" variant="tertiary" className="h-10" disabled={updating} onClick={resetDates}>
            Reset to full month
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button type="button" className="h-10" disabled={!month || busy} onClick={() => load(month, range, true)}>
            <RotateCcw className={cn(loading && 'animate-spin')} />
            Refresh data
          </Button>
          <Button
            type="button"
            variant="primary"
            className="h-10"
            disabled={!snap || busy}
            onClick={() => setConfirmOpen(true)}
          >
            {updating && <Loader2 className="animate-spin" />}
            {updating ? 'Updating…' : 'Update both tables'}
          </Button>
        </div>
      </div>

      {lastUpdate && (
        <div className="flex items-center gap-2 rounded-lg border border-green-300 bg-green-50 px-3 py-2 text-green-800 text-sm dark:border-green-900 dark:bg-green-950/30 dark:text-green-300">
          <Check className="size-4 shrink-0" />
          {lastUpdate.month} updated by {lastUpdate.user}
          {lastUpdate.custom_range
            ? ` for ${fmtDate(lastUpdate.period_start)} – ${fmtDate(lastUpdate.period_end)} only`
            : ''}
          . Weekday table: {lastUpdate.weekday.inserted} added, {lastUpdate.weekday.updated} changed. Weekend table:{' '}
          {lastUpdate.weekend.inserted} added, {lastUpdate.weekend.updated} changed.
        </div>
      )}

      {isCustom && full && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900 text-sm dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          Custom date range: the numbers below cover {shown ? `${fmtDate(shown.start)} – ${fmtDate(shown.end)}` : ''}{' '}
          only, not the full broadcast month ({fmtDate(full.start)} – {fmtDate(full.end)}). Update both tables will save
          these numbers as the {month} values.
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive text-sm">
          {error}
        </div>
      )}

      {loading && !snap && (
        <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="size-4 animate-spin" />
          Calculating {month} from the Nielsen data…
        </div>
      )}

      {snap && (
        <div className={cn('flex min-h-0 flex-1 flex-col gap-3', loading && 'opacity-60')}>
          <div className="flex flex-wrap items-center gap-2">
            {(['weekday', 'weekend'] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => {
                  setView(k);
                  setNetwork('all');
                }}
                className={cn(
                  'h-10 cursor-pointer rounded-lg border px-4 text-sm',
                  view === k
                    ? 'border-transparent bg-primary/15 font-semibold text-primary'
                    : 'border-input text-muted-foreground',
                )}
              >
                {k === 'weekday' ? 'Weekday' : 'Weekend'} table ({snap[k].rows.length})
              </button>
            ))}
            <Button
              type="button"
              className="ml-auto h-9"
              onClick={() =>
                downloadCsv(
                  snap.custom_range
                    ? `program_${view}_${snap.month}_${snap.period_start}_to_${snap.period_end}.csv`
                    : `program_${view}_${snap.month}.csv`,
                  snap[view],
                )
              }
            >
              <Download />
              Download table (CSV)
            </Button>
          </div>

          <div className="flex justify-end">
            <select
              id="hist-network-filter"
              aria-label="Filter by network"
              className="h-10 min-w-56 cursor-pointer rounded-lg border border-input bg-background px-3 text-sm"
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
          </div>

          <SnapshotTable key={`${snap.month}-${snap.period_start}-${snap.period_end}-${view}`} data={snap[view]} network={network} />
        </div>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Update {month}?</AlertDialogTitle>
            <AlertDialogDescription>
              This updates both program tables in one go, the weekday table and the weekend table.{' '}
              {pending === 0
                ? `They already match what is shown: ${totals.unchanged} rows unchanged. Updating will change nothing.`
                : `Across both: ${totals.added} new rows will be added, ${totals.changed} changed rows will be updated, and ${totals.unchanged} unchanged rows will be left as they are.`}
              {snap
                ? ` Weekday: ${snap.weekday.counts.New} new, ${snap.weekday.counts.Changed} changed. Weekend: ${snap.weekend.counts.New} new, ${snap.weekend.counts.Changed} changed.`
                : ''}
              {isCustom && shown && full
                ? ` These numbers cover ${fmtDate(shown.start)} – ${fmtDate(shown.end)} only. They will be saved as the ${month} values and replace any full-month values (${fmtDate(full.start)} – ${fmtDate(full.end)}) already in the tables.`
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={runUpdate}>Update both tables</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

type DpTable = { key: string; table: string; grain: 'day' | 'week' | 'month' | 'quarter' | 'year'; group: 'standard' | 'currency' };
type DpPeriod = { label: string; start: string; end: string };
type DpRow = {
  Period: string;
  Network: string;
  Daypart: string;
  Demographic: string;
  Feed_type: string;
  Impression: number | null;
  Start: string;
  End: string;
  old_impression: number | null;
  status: Status;
};
type DpSnap = {
  table_key: string;
  table: string;
  period: string;
  period_start_full: string;
  period_end_full: string;
  period_start: string;
  period_end: string;
  custom_range: boolean;
  rows: DpRow[];
  counts: Record<Status, number>;
};
type DpUpdate = { table: string; period: string; user: string; inserted: number; updated: number; custom_range: boolean; period_start: string; period_end: string };
type DpSortKey = 'Network' | 'Daypart' | 'Demographic' | 'Impression';

const DP_API = '/api/hist/daypart';
const GRAIN_LABEL: Record<DpTable['grain'], string> = { day: 'Day', week: 'Week', month: 'Month', quarter: 'Quarter', year: 'Year' };

function DaypartTable({ rows: all, network, table }: { rows: DpRow[]; network: string; table: string }) {
  const [sort, setSort] = useState<{ key: DpSortKey; asc: boolean } | null>(null);
  const rows = useMemo(() => {
    const filtered = all.filter((r) => network === 'all' || r.Network === network);
    if (!sort) return filtered;
    const dir = sort.asc ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const x = a[sort.key];
      const y = b[sort.key];
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
      return String(x ?? '').localeCompare(String(y ?? '')) * dir;
    });
  }, [all, network, sort]);

  const head = (label: string, key?: DpSortKey, right = false) => (
    <th className={cn('px-3 py-2.5 font-semibold', right && 'text-right')}>
      {key ? (
        <button
          type="button"
          className={cn('inline-flex cursor-pointer items-center gap-1', right && 'flex-row-reverse')}
          onClick={() => setSort((s) => (s?.key === key ? { key, asc: !s.asc } : { key, asc: true }))}
          title={`Sort by ${label}`}
        >
          {label}
          <ArrowUpDown className={cn('size-3.5', sort?.key === key ? 'text-primary' : 'text-muted-foreground')} />
        </button>
      ) : (
        label
      )}
    </th>
  );

  return (
    <>
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border">
        <table className="w-full min-w-[720px] border-collapse text-sm">
          <thead className="sticky top-0 bg-muted text-left text-xs">
            <tr>
              {head('Network', 'Network')}
              {head('Daypart', 'Daypart')}
              {head('Demo', 'Demographic')}
              {head('Start')}
              {head('End')}
              {head('Impression', 'Impression', true)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.Network}|${r.Daypart}|${r.Demographic}`} className="border-t">
                <td className="px-3 py-2">{r.Network}</td>
                <td className="whitespace-nowrap px-3 py-2">{r.Daypart}</td>
                <td className="whitespace-nowrap px-3 py-2">{r.Demographic}</td>
                <td className="whitespace-nowrap px-3 py-2">{r.Start}</td>
                <td className="whitespace-nowrap px-3 py-2">{r.End}</td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums">{fmtNum(r.Impression)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-muted-foreground">
                  No rows for this selection.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="text-muted-foreground text-sm">
        Showing {rows.length} of {all.length} rows
      </p>
      <p className="text-muted-foreground text-xs italic">writes to: {table}</p>
    </>
  );
}

function downloadDaypartCsv(name: string, rows: DpRow[]) {
  const cols: (keyof DpRow)[] = ['Period', 'Network', 'Daypart', 'Demographic', 'Feed_type', 'Impression'];
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))];
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function DaypartTab() {
  const [tables, setTables] = useState<DpTable[]>([]);
  const [tableKey, setTableKey] = useState('monthly');
  const [periods, setPeriods] = useState<DpPeriod[]>([]);
  const [period, setPeriod] = useState('');
  const [range, setRange] = useState<DateRange | null>(null);
  const [snap, setSnap] = useState<DpSnap | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [network, setNetwork] = useState('all');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<DpUpdate | null>(null);
  const cache = useRef(new Map<string, DpSnap>());
  const latest = useRef(0);

  const current = tables.find((t) => t.key === tableKey);
  const full = periods.find((p) => p.label === period);
  const shown = range ?? (full ? { start: full.start, end: full.end } : undefined);
  const isCustom = range !== null;

  useEffect(() => {
    fetchJson<{ tables: DpTable[] }>(`${DP_API}/tables`)
      .then((r) => setTables(r.tables))
      .catch((e) => setError((e as Error).message));
  }, []);

  useEffect(() => {
    setPeriods([]);
    setPeriod('');
    setSnap(null);
    setError(null);
    fetchJson<{ periods: DpPeriod[] }>(`${DP_API}/periods?table=${encodeURIComponent(tableKey)}`)
      .then((r) => {
        setPeriods(r.periods);
        if (r.periods.length) setPeriod(r.periods[0].label);
        else setError('No periods found for this table.');
      })
      .catch((e) => setError((e as Error).message));
  }, [tableKey]);

  const load = useCallback(async (t: string, p: string, r: DateRange | null, fresh = false) => {
    const id = ++latest.current;
    const key = `${t}|${p}|${r?.start ?? ''}|${r?.end ?? ''}`;
    const cached = fresh ? undefined : cache.current.get(key);
    setError(null);
    if (cached) {
      setSnap(cached);
      setLoading(false);
      return;
    }
    setSnap(null);
    setLoading(true);
    try {
      const dates = r ? `&start=${r.start}&end=${r.end}` : '';
      const result = await fetchJson<DpSnap>(
        `${DP_API}/snapshot?table=${encodeURIComponent(t)}&period=${encodeURIComponent(p)}${dates}`,
      );
      cache.current.set(key, result);
      if (id === latest.current) setSnap(result);
    } catch (e) {
      if (id === latest.current) setError((e as Error).message);
    } finally {
      if (id === latest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (period) {
      setLastUpdate(null);
      setNetwork('all');
      setRange(null);
      load(tableKey, period, null);
    }
  }, [tableKey, period, load]);

  const changeDate = (which: 'start' | 'end', value: string) => {
    if (!full || !value) return;
    const next = { start: shown?.start ?? full.start, end: shown?.end ?? full.end, [which]: value };
    if (next.start > next.end || next.start < full.start || next.end > full.end) {
      toast.error(`Pick dates between ${fmtDate(full.start)} and ${fmtDate(full.end)}, start before end.`);
      return;
    }
    const custom = next.start === full.start && next.end === full.end ? null : next;
    setRange(custom);
    setLastUpdate(null);
    load(tableKey, period, custom);
  };

  const networks = useMemo(() => (snap ? Array.from(new Set(snap.rows.map((r) => r.Network))).sort() : []), [snap]);
  const busy = loading || updating;
  const pending = snap ? snap.counts.New + snap.counts.Changed : 0;

  const runUpdate = async () => {
    setConfirmOpen(false);
    setUpdating(true);
    try {
      const body = { table: tableKey, period, ...(range ? { start: range.start, end: range.end } : {}) };
      const result = await fetchJson<DpUpdate>(`${DP_API}/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      setLastUpdate(result);
      toast.success(`${result.period} updated: ${result.inserted} added, ${result.updated} changed`);
      cache.current.clear();
      await load(tableKey, period, range, true);
    } catch (e) {
      toast.error(`Update failed: ${(e as Error).message}`);
    } finally {
      setUpdating(false);
    }
  };

  const grainLabel = current ? GRAIN_LABEL[current.grain] : 'Period';

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <select
          id="dp-table"
          aria-label="Daypart table"
          className="h-10 min-w-80 cursor-pointer rounded-lg border border-input bg-background px-3 font-medium text-sm"
          value={tableKey}
          disabled={updating || tables.length === 0}
          onChange={(e) => setTableKey(e.target.value)}
        >
          {(['standard', 'currency'] as const).map((g) => (
            <optgroup key={g} label={g === 'standard' ? 'Standard tables (averages and YoY)' : 'Currency tables (milestones and streaks)'}>
              {tables
                .filter((t) => t.group === g)
                .map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.table.split('.').pop()}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
        <label htmlFor="dp-period" className={BOX}>
          <span className="text-muted-foreground">{grainLabel}:</span>
          <select
            id="dp-period"
            className="cursor-pointer bg-transparent font-medium focus-visible:outline-hidden"
            value={period}
            disabled={updating || periods.length === 0}
            onChange={(e) => setPeriod(e.target.value)}
          >
            {periods.map((p) => (
              <option key={p.label} value={p.label}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor="dp-start" className={cn(BOX, isCustom && 'border-primary')}>
          <CalendarDays className="size-4 text-muted-foreground" />
          <span className="text-muted-foreground">Start date:</span>
          <input
            id="dp-start"
            type="date"
            className="cursor-pointer bg-transparent font-medium focus-visible:outline-hidden"
            value={shown?.start ?? ''}
            min={full?.start}
            max={shown?.end ?? full?.end}
            disabled={!full || updating}
            onChange={(e) => changeDate('start', e.target.value)}
          />
        </label>
        <label htmlFor="dp-end" className={cn(BOX, isCustom && 'border-primary')}>
          <CalendarDays className="size-4 text-muted-foreground" />
          <span className="text-muted-foreground">End date:</span>
          <input
            id="dp-end"
            type="date"
            className="cursor-pointer bg-transparent font-medium focus-visible:outline-hidden"
            value={shown?.end ?? ''}
            min={shown?.start ?? full?.start}
            max={full?.end}
            disabled={!full || updating}
            onChange={(e) => changeDate('end', e.target.value)}
          />
        </label>
        {isCustom && (
          <Button
            type="button"
            variant="tertiary"
            className="h-10"
            disabled={updating}
            onClick={() => {
              setRange(null);
              load(tableKey, period, null);
            }}
          >
            Reset to full {grainLabel.toLowerCase()}
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button type="button" className="h-10" disabled={!period || busy} onClick={() => load(tableKey, period, range, true)}>
            <RotateCcw className={cn(loading && 'animate-spin')} />
            Refresh data
          </Button>
          <Button type="button" variant="primary" className="h-10" disabled={!snap || busy} onClick={() => setConfirmOpen(true)}>
            {updating && <Loader2 className="animate-spin" />}
            {updating ? 'Updating…' : 'Update table'}
          </Button>
        </div>
      </div>
      <p className="text-muted-foreground text-xs">
        Standard tables hold the daypart averages and the prior-year figures used for YoY growth. Currency tables power the
        historical milestones and consecutive streaks.
      </p>

      {lastUpdate && (
        <div className="flex items-center gap-2 rounded-lg border border-green-300 bg-green-50 px-3 py-2 text-green-800 text-sm dark:border-green-900 dark:bg-green-950/30 dark:text-green-300">
          <Check className="size-4 shrink-0" />
          {lastUpdate.period} updated by {lastUpdate.user}
          {lastUpdate.custom_range ? ` for ${fmtDate(lastUpdate.period_start)} – ${fmtDate(lastUpdate.period_end)} only` : ''}:{' '}
          {lastUpdate.inserted} added, {lastUpdate.updated} changed.
        </div>
      )}

      {isCustom && full && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900 text-sm dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          Custom date range: the numbers below cover {shown ? `${fmtDate(shown.start)} – ${fmtDate(shown.end)}` : ''} only, not
          the full {grainLabel.toLowerCase()} ({fmtDate(full.start)} – {fmtDate(full.end)}). Update table will save them as the{' '}
          {period} values.
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive text-sm">{error}</div>
      )}

      {loading && !snap && (
        <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="size-4 animate-spin" />
          Calculating {period} from the Nielsen data…
        </div>
      )}

      {snap && (
        <div className={cn('flex min-h-0 flex-1 flex-col gap-3', loading && 'opacity-60')}>
          <div className="flex justify-end">
            <Button
              type="button"
              className="h-9"
              onClick={() =>
                downloadDaypartCsv(
                  snap.custom_range
                    ? `daypart_${snap.table_key}_${snap.period}_${snap.period_start}_to_${snap.period_end}.csv`
                    : `daypart_${snap.table_key}_${snap.period}.csv`,
                  snap.rows,
                )
              }
            >
              <Download />
              Download table (CSV)
            </Button>
          </div>
          <div className="flex justify-end">
            <select
              id="dp-network-filter"
              aria-label="Filter by network"
              className="h-10 min-w-56 cursor-pointer rounded-lg border border-input bg-background px-3 text-sm"
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
          </div>
          <DaypartTable key={`${snap.table_key}-${snap.period}-${snap.period_start}-${snap.period_end}`} rows={snap.rows} network={network} table={snap.table} />
        </div>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Update {period} in {current?.table.split('.').pop()}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {snap && pending === 0
                ? `The table already matches what is shown: ${snap.counts.Unchanged} rows unchanged. Updating will change nothing.`
                : snap
                  ? `${snap.counts.New} new rows will be added, ${snap.counts.Changed} changed rows will be updated, and ${snap.counts.Unchanged} unchanged rows will be left as they are.`
                  : ''}
              {isCustom && shown && full
                ? ` These numbers cover ${fmtDate(shown.start)} – ${fmtDate(shown.end)} only and will be saved as the ${period} values.`
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={runUpdate}>Update table</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default function HistoricalUpdatePage() {
  const [tab, setTab] = useState<'program' | 'daypart'>('program');
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4 md:p-6">
      <h1 className="font-semibold text-2xl">Historical Update</h1>
      <div className="flex gap-6 border-b">
        {(['program', 'daypart'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              '-mb-px cursor-pointer border-b-2 px-3 pb-2 text-base',
              tab === t ? 'border-primary font-semibold text-primary' : 'border-transparent text-muted-foreground',
            )}
          >
            {t === 'program' ? 'Program' : 'Daypart'}
          </button>
        ))}
      </div>
      {tab === 'program' ? <ProgramTab /> : <DaypartTab />}
    </div>
  );
}
