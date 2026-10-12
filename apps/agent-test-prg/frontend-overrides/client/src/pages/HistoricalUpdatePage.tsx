import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Check, Loader2, RefreshCw } from 'lucide-react';
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
  Network: string;
  Daypart: string;
  Program: string;
  Start: string;
  End: string;
  Demo: string;
  TCs: number | null;
  Dur: number | null;
  Impressions: number | null;
  old_impressions: number | null;
  old_dur: number | null;
  old_tcs: number | null;
  status: Status;
};

type TableSnapshot = {
  table: string;
  rows: Row[];
  counts: Record<Status, number>;
  has_tcs: boolean;
  records_user: boolean;
  records_timestamps: boolean;
};

type Snapshot = {
  month: string;
  period_start: string;
  period_end: string;
  weekday: TableSnapshot;
  weekend: TableSnapshot;
};

type UpdateResult = { month: string; user: string; inserted: number; updated: number };

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

const fmtNum = (v: number | null) => (v === null || v === undefined ? '—' : v.toLocaleString());

const ROW_TONE: Record<Status, string> = {
  New: 'bg-green-50 dark:bg-green-950/30',
  Changed: 'bg-amber-50 dark:bg-amber-950/30',
  Unchanged: '',
};

const SELECT =
  'h-8 rounded-lg border border-input bg-background px-2 text-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring';

function Tile({ value, label, tone }: { value: number; label: string; tone: string }) {
  return (
    <div className={cn('min-w-0 flex-1 rounded-lg px-4 py-3', tone)}>
      <div className="font-semibold text-xl tabular-nums">{value.toLocaleString()}</div>
      <div className="text-muted-foreground text-xs">{label}</div>
    </div>
  );
}

function SnapshotTable({ data }: { data: TableSnapshot }) {
  const [network, setNetwork] = useState('all');
  const [status, setStatus] = useState('all');
  const networks = useMemo(() => Array.from(new Set(data.rows.map((r) => r.Network))).sort(), [data.rows]);
  const rows = data.rows.filter(
    (r) => (network === 'all' || r.Network === network) && (status === 'all' || r.status === status),
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="truncate text-muted-foreground text-xs" title={data.table}>
          Writes to {data.table}
        </span>
        <div className="flex gap-2">
          <select
            id="hist-network-filter"
            aria-label="Filter by network"
            className={SELECT}
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
            id="hist-status-filter"
            aria-label="Filter by status"
            className={SELECT}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="all">All statuses</option>
            <option value="New">New</option>
            <option value="Changed">Changed</option>
            <option value="Unchanged">Unchanged</option>
          </select>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border">
        <table className="w-full min-w-[820px] border-collapse text-sm">
          <thead className="sticky top-0 bg-muted text-left text-xs">
            <tr>
              {['Network', 'Daypart', 'Program', 'Start', 'End', 'Demo'].map((h) => (
                <th key={h} className="px-3 py-2 font-medium">
                  {h}
                </th>
              ))}
              {data.has_tcs && <th className="px-3 py-2 text-right font-medium">TCs</th>}
              <th className="px-3 py-2 text-right font-medium">Dur</th>
              <th className="px-3 py-2 text-right font-medium">In table</th>
              <th className="px-3 py-2 text-right font-medium">New value</th>
              <th className="px-3 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={`${r.Network}|${r.Daypart}|${r.Program}|${r.Demo}`}
                className={cn('border-t', ROW_TONE[r.status])}
              >
                <td className="px-3 py-1.5">{r.Network}</td>
                <td className="px-3 py-1.5">{r.Daypart}</td>
                <td className="px-3 py-1.5">{r.Program}</td>
                <td className="whitespace-nowrap px-3 py-1.5">{r.Start}</td>
                <td className="whitespace-nowrap px-3 py-1.5">{r.End}</td>
                <td className="whitespace-nowrap px-3 py-1.5">{r.Demo}</td>
                {data.has_tcs && <td className="px-3 py-1.5 text-right tabular-nums">{fmtNum(r.TCs)}</td>}
                <td className="px-3 py-1.5 text-right tabular-nums">{fmtNum(r.Dur)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                  {r.status === 'New' ? '—' : fmtNum(r.old_impressions)}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums font-medium">{fmtNum(r.Impressions)}</td>
                <td className="px-3 py-1.5">{r.status}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={11} className="px-3 py-6 text-center text-muted-foreground">
                  No rows match the filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ProgramTab() {
  const [months, setMonths] = useState<string[]>([]);
  const [month, setMonth] = useState('');
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'weekday' | 'weekend'>('weekday');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<UpdateResult | null>(null);

  const load = useCallback(async (m: string) => {
    setLoading(true);
    setError(null);
    try {
      setSnap(await api<Snapshot>(`/snapshot?month=${encodeURIComponent(m)}`));
    } catch (e) {
      setSnap(null);
      setError((e as Error).message);
    } finally {
      setLoading(false);
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
      load(month);
    }
  }, [month, load]);

  const totals = useMemo(() => {
    if (!snap) return { rows: 0, added: 0, changed: 0, unchanged: 0 };
    const t = [snap.weekday, snap.weekend];
    return {
      rows: t.reduce((n, x) => n + x.rows.length, 0),
      added: t.reduce((n, x) => n + x.counts.New, 0),
      changed: t.reduce((n, x) => n + x.counts.Changed, 0),
      unchanged: t.reduce((n, x) => n + x.counts.Unchanged, 0),
    };
  }, [snap]);

  const pending = totals.added + totals.changed;

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
      await load(month);
    } catch (e) {
      toast.error(`Update failed: ${(e as Error).message}`);
    } finally {
      setUpdating(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="hist-month" className="font-medium text-sm">
          Month
        </label>
        <select
          id="hist-month"
          className={SELECT}
          value={month}
          disabled={loading || updating || months.length === 0}
          onChange={(e) => setMonth(e.target.value)}
        >
          {months.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        {snap && (
          <span className="text-muted-foreground text-sm">
            {fmtDate(snap.period_start)} – {fmtDate(snap.period_end)}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button
            type="button"
            title="Recalculate"
            disabled={!month || loading || updating}
            onClick={() => load(month)}
          >
            <RefreshCw className={cn(loading && 'animate-spin')} />
            Refresh
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={!snap || loading || updating || pending === 0}
            onClick={() => setConfirmOpen(true)}
          >
            {updating && <Loader2 className="animate-spin" />}
            {updating ? 'Updating…' : snap && pending === 0 ? 'Up to date' : 'Update tables'}
          </Button>
        </div>
      </div>

      {lastUpdate && (
        <div className="flex items-center gap-2 rounded-lg border border-green-300 bg-green-50 px-3 py-2 text-green-800 text-sm dark:border-green-900 dark:bg-green-950/30 dark:text-green-300">
          <Check className="size-4 shrink-0" />
          {lastUpdate.month} updated by {lastUpdate.user}: {lastUpdate.inserted} added, {lastUpdate.updated} changed.
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
        <>
          <div className={cn('flex flex-wrap gap-3', loading && 'opacity-60')}>
            <Tile value={totals.rows} label="rows calculated" tone="bg-muted" />
            <Tile value={totals.added} label="new" tone="bg-green-50 dark:bg-green-950/30" />
            <Tile value={totals.changed} label="changed" tone="bg-amber-50 dark:bg-amber-950/30" />
            <Tile value={totals.unchanged} label="unchanged" tone="bg-muted" />
          </div>

          <div className="flex gap-2">
            {(['weekday', 'weekend'] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setView(k)}
                className={cn(
                  'cursor-pointer rounded-full border px-3 py-1 text-sm',
                  view === k ? 'border-primary bg-primary/10 font-medium text-primary' : 'text-muted-foreground',
                )}
              >
                {k === 'weekday' ? 'Weekday' : 'Weekend'} table ({snap[k].rows.length})
              </button>
            ))}
          </div>

          <SnapshotTable key={`${snap.month}-${view}`} data={snap[view]} />

          {!snap.weekday.records_user && (
            <p className="text-muted-foreground text-xs">
              The tables have no user_id column yet, so the person who runs an update is not stored in the table.
            </p>
          )}
        </>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Update {month}?</AlertDialogTitle>
            <AlertDialogDescription>
              This adds {totals.added} new row{totals.added === 1 ? '' : 's'} and updates {totals.changed} changed row
              {totals.changed === 1 ? '' : 's'} in the weekday and weekend program tables. Unchanged rows are left as
              they are.
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
    <div className="flex h-full min-h-0 flex-col gap-3 p-4 md:p-6">
      <h1 className="font-semibold text-lg">Historical Update</h1>
      <div className="flex gap-4 border-b">
        {(['program', 'daypart'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              '-mb-px cursor-pointer border-b-2 px-1 pb-2 text-sm',
              tab === t ? 'border-primary font-medium text-primary' : 'border-transparent text-muted-foreground',
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
