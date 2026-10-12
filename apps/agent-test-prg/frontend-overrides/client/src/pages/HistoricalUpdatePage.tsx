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
  period_start: string;
  period_end: string;
  weekday: TableSnapshot;
  weekend: TableSnapshot;
};

type UpdateResult = { month: string; user: string; inserted: number; updated: number };

type SortKey = 'Network' | 'Daypart' | 'Program' | 'Demo' | 'TCs' | 'Dur' | 'Impressions';

const API = '/api/hist/program';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, init);
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

  // Snapshots already fetched this visit, so switching back to a month is instant.
  const cache = useRef(new Map<string, Snapshot>());
  // Only the newest request may update the page; older ones are ignored when they return.
  const latest = useRef(0);

  const load = useCallback(async (m: string, fresh = false) => {
    const id = ++latest.current;
    const cached = fresh ? undefined : cache.current.get(m);
    setError(null);
    if (cached) {
      setSnap(cached);
      setLoading(false);
      return;
    }
    setSnap(null);
    setLoading(true);
    try {
      const result = await api<Snapshot>(`/snapshot?month=${encodeURIComponent(m)}`);
      cache.current.set(m, result);
      if (id === latest.current) setSnap(result);
    } catch (e) {
      if (id === latest.current) setError((e as Error).message);
    } finally {
      if (id === latest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    api<{ months: { label: string }[] }>('/months')
      .then((r) => {
        const labels = r.months.map((x) => x.label);
        setMonths(labels);
        if (labels.length) setMonth(labels[0]);
        else setError('The program flag table has no months.');
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  useEffect(() => {
    if (month) {
      setLastUpdate(null);
      setNetwork('all');
      load(month);
    }
  }, [month, load]);

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
        body: JSON.stringify({ month }),
      });
      setLastUpdate(result);
      toast.success(`${result.month} updated: ${result.inserted} added, ${result.updated} changed`);
      await load(month, true);
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
        <div className={BOX}>
          <CalendarDays className="size-4 text-muted-foreground" />
          <span className="text-muted-foreground">Start date:</span>
          <span className="font-medium">{snap ? fmtDate(snap.period_start) : '—'}</span>
        </div>
        <div className={BOX}>
          <CalendarDays className="size-4 text-muted-foreground" />
          <span className="text-muted-foreground">End date:</span>
          <span className="font-medium">{snap ? fmtDate(snap.period_end) : '—'}</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button type="button" className="h-10" disabled={!month || busy} onClick={() => load(month, true)}>
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
            {updating ? 'Updating…' : 'Update tables'}
          </Button>
        </div>
      </div>

      {lastUpdate && (
        <div className="flex items-center gap-2 rounded-lg border border-green-300 bg-green-50 px-3 py-2 text-green-800 text-sm dark:border-green-900 dark:bg-green-950/30 dark:text-green-300">
          <Check className="size-4 shrink-0" />
          {lastUpdate.month} updated by {lastUpdate.user}: {lastUpdate.inserted} rows added, {lastUpdate.updated} rows
          changed.
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
              onClick={() => downloadCsv(`program_${view}_${snap.month}.csv`, snap[view])}
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

          <SnapshotTable key={`${snap.month}-${view}`} data={snap[view]} network={network} />
        </div>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Update {month}?</AlertDialogTitle>
            <AlertDialogDescription>
              {pending === 0
                ? `The tables already match ${month}: ${totals.unchanged} rows unchanged. Updating will change nothing.`
                : `Compared with the tables: ${totals.added} new rows will be added, ${totals.changed} changed rows will be updated, and ${totals.unchanged} unchanged rows will be left as they are.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={runUpdate}>Update tables</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function DaypartTab() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="max-w-md rounded-lg border bg-muted/40 p-8 text-center">
        <h2 className="font-semibold text-base">Daypart update: coming next</h2>
        <p className="mt-2 text-muted-foreground text-sm">
          Same flow as the Program page for the 7 daypart history tables. The daypart list will come from a daypart
          flag table (like the program flag table), replacing the list that is hardcoded in the load today.
        </p>
      </div>
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
