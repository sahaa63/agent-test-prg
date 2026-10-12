import { Badge } from '@/components/ui/badge';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import type { ToolUIPart } from 'ai';
import { useContext, useState, type ComponentProps, type ReactNode } from 'react';
import { CodeBlock } from './code-block';
import { createContext } from 'react';
import { AlertCircle, Check, ChevronRight, Loader2 } from 'lucide-react';
import { ShieldCheckIcon, ShieldOffIcon as ShieldXIcon, XCircleIcon, CircleOutlineIcon as CircleIcon, ClockIcon, CheckCircleIcon } from '../icons';

// Shared types - uses AI SDK's native tool states
export type ToolState = ToolUIPart['state'];

// Shared status badge component (still used by the MCP approval card)
type ToolStatusBadgeProps = {
  state: ToolState;
  className?: string;
};

export const ToolStatusBadge = ({ state, className }: ToolStatusBadgeProps) => {
  const labels: Record<ToolState, string> = {
    'input-streaming': 'Pending',
    'input-available': 'Running',
    'output-available': 'Completed',
    'output-error': 'Error',
    'output-denied': 'Denied',
    'approval-requested': 'Approval Requested',
    'approval-responded': 'Processing',
  };

  const icons: Record<ToolState, ReactNode> = {
    'input-streaming': <CircleIcon className="size-3" />,
    'input-available': <ClockIcon className="size-3 animate-pulse" />,
    'output-available': <CheckCircleIcon className="size-3" />,
    'output-error': <XCircleIcon className="size-3" />,
    'output-denied': <ShieldXIcon className="size-3" />,
    'approval-requested': <ShieldXIcon className="size-3" />,
    'approval-responded': <ShieldCheckIcon className="size-3" />,
  };

  const variants: Record<ToolState, string> = {
    'input-streaming':
      'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
    'input-available':
      'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
    'output-available':
      'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
    'output-error': 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
    'output-denied':
      'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
    'approval-requested':
      'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
    'approval-responded':
      'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  };

  return (
    <Badge
      className={cn(
        'flex items-center gap-1 rounded-full border-0 font-medium text-xs',
        variants[state],
        className,
      )}
      variant="secondary"
    >
      {icons[state]}
      <span>{labels[state]}</span>
    </Badge>
  );
};

// Shared container component
type ToolContainerProps = ComponentProps<typeof Collapsible>;

const ToolContext = createContext<{
  open: boolean;
}>({
  open: false,
});

export const ToolContainer = ({ className, ...props }: ToolContainerProps) => {
  const [open, setOpen] = useState(props.defaultOpen || false);
  return (
    <ToolContext.Provider value={{ open }}>
      <Collapsible
        className={cn('not-prose w-full rounded-xl border', className)}
        open={open}
        onOpenChange={setOpen}
        {...props}
      /></ToolContext.Provider>
  );
}

// Shared collapsible content component
type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      'data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-popover-foreground outline-hidden data-[state=closed]:animate-out data-[state=open]:animate-in',
      className,
    )}
    {...props}
  />
);

// Shared input component
type ToolInputProps = ComponentProps<'div'> & {
  input: ToolUIPart['input'];
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div className={cn('space-y-2 overflow-hidden p-3', className)} {...props}>
    <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
      Parameters
    </h4>
    <div className="rounded-md bg-muted/50">
      <CodeBlock code={JSON.stringify(input, null, 2)} language="json" />
    </div>
  </div>
);

// Shared output component
type ToolOutputProps = ComponentProps<'div'> & {
  output: ReactNode;
  errorText?: string;
};

export const ToolOutput = ({
  className,
  output,
  errorText,
  ...props
}: ToolOutputProps) => {
  if (!(output || errorText)) {
    return null;
  }

  return (
    <div className={cn('space-y-2 p-3', className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {errorText ? 'Error' : 'Result'}
      </h4>
      <div
        className={cn(
          'overflow-x-auto rounded-md text-xs [&_table]:w-full',
          errorText
            ? 'bg-destructive/10 text-destructive'
            : 'bg-muted/50 text-foreground',
        )}
      >
        {errorText && <div className="p-2">{errorText}</div>}
        {output && <div>{output}</div>}
      </div>
    </div>
  );
};

// Standard tool call: a plain status line. The parameters and result stay
// available behind the expand arrow, collapsed by default.
export const Tool = ({ className, defaultOpen: _defaultOpen, ...props }: ToolContainerProps) => {
  const [open, setOpen] = useState(false);
  return (
    <ToolContext.Provider value={{ open }}>
      <Collapsible
        className={cn('not-prose w-full', open && 'rounded-lg border bg-muted/20', className)}
        open={open}
        onOpenChange={setOpen}
        {...props}
      />
    </ToolContext.Provider>
  );
};

// [match on tool name, text while running, text when finished]
const TOOL_ACTIVITY: [string, string, string][] = [
  ['metadata', 'Looking up the measurement period', 'Found the measurement period'],
  ['flag_disclaimer', 'Checking the program lineup flags', 'Checked the program lineup flags'],
  ['validate_flags', 'Validating the flag table', 'Validated the flag table'],
  ['dp_filter', 'Loading the program lineup', 'Loaded the program lineup'],
  ['param_options', 'Looking up the available options', 'Loaded the available options'],
  ['prior_dp_ratings', 'Pulling prior-year daypart ratings', 'Pulled prior-year daypart ratings'],
  ['cur_dp_ratings', "Pulling this period's daypart ratings", "Pulled this period's daypart ratings"],
  ['prior_prog_ratings', 'Pulling prior-year program ratings', 'Pulled prior-year program ratings'],
  ['cur_prog_ratings', "Pulling this period's program ratings", "Pulled this period's program ratings"],
  ['slot_wins', 'Comparing time slots against CNN and Fox News', 'Compared time slots against CNN and Fox News'],
  ['hist_dp_kpi', 'Checking daypart records and best-since claims', 'Checked daypart records and best-since claims'],
  ['hist_prog_kpi', 'Checking program records and best-since claims', 'Checked program records and best-since claims'],
  ['consec_growth', 'Checking consecutive growth streaks', 'Checked consecutive growth streaks'],
  ['consec_wins', 'Checking consecutive win streaks', 'Checked consecutive win streaks'],
  ['spike_best_day', 'Finding the best day in the period', 'Found the best day in the period'],
  ['active_programs', 'Listing the programs that aired', 'Listed the programs that aired'],
  ['episode_detail', 'Pulling episode details', 'Pulled episode details'],
  ['genie', 'Asking the Nielsen data assistant', 'Got an answer from the Nielsen data assistant'],
  ['query_space', 'Asking the Nielsen data assistant', 'Got an answer from the Nielsen data assistant'],
  ['poll_response', 'Waiting for the Nielsen data assistant', 'Got an answer from the Nielsen data assistant'],
];

const describeTool = (toolName: string): { running: string; done: string } => {
  const name = toolName.toLowerCase();
  const hit = TOOL_ACTIVITY.find(([key]) => name.includes(key));
  if (hit) return { running: hit[1], done: hit[2] };
  const readable = toolName.split('__').pop()?.replace(/_/g, ' ') ?? toolName;
  return { running: `Running ${readable}`, done: `Finished ${readable}` };
};

type ToolHeaderProps = {
  type: ToolUIPart['type'] | string;
  state: ToolState;
  className?: string;
};

export const ToolHeader = ({
  className,
  type,
  state,
  ...props
}: ToolHeaderProps) => {
  const { open } = useContext(ToolContext);
  const { running, done } = describeTool(String(type));
  const failed = state === 'output-error' || state === 'output-denied';
  const finished = state === 'output-available';
  const text = failed
    ? `${running} did not complete`
    : finished
      ? done
      : `${running}…`;

  return (
    <CollapsibleTrigger
      className={cn(
        'group flex w-full min-w-0 cursor-pointer items-center gap-2 px-1 py-1 text-left text-sm',
        open && 'px-3 py-2',
        className,
      )}
      title={open ? 'Hide details' : 'Show details'}
      {...props}
    >
      {failed ? (
        <AlertCircle className="size-3.5 shrink-0 text-destructive" />
      ) : finished ? (
        <Check className="size-3.5 shrink-0 text-green-600 dark:text-green-400" />
      ) : (
        <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
      )}
      <span
        className={cn(
          'truncate text-muted-foreground',
          !finished && !failed && 'animate-pulse',
          failed && 'text-destructive',
        )}
      >
        {text}
      </span>
      <ChevronRight
        className={cn(
          'size-3.5 shrink-0 text-muted-foreground/60 opacity-0 transition group-hover:opacity-100',
          open && 'rotate-90 opacity-100',
        )}
      />
    </CollapsibleTrigger>
  );
}
