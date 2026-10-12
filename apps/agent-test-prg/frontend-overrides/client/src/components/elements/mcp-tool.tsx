import { cn } from '@/lib/utils';
import {
  AlertCircle,
  Check,
  ChevronDownIcon,
  Loader2,
  ShieldAlertIcon,
  ShieldCheckIcon,
  ShieldXIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CollapsibleTrigger } from '@/components/ui/collapsible';
import { describeTool, ToolContainer, type ToolState } from './tool';

export type { ToolState };

// MCP-specific container with the same card styling as the upstream template.
type McpToolProps = Parameters<typeof ToolContainer>[0];

export const McpTool = ({ className, ...props }: McpToolProps) => (
  <ToolContainer
    className={cn('overflow-hidden rounded-lg bg-muted/30', className)}
    {...props}
  />
);

// Re-export shared components for convenience.
export {
  ToolContent as McpToolContent,
  ToolInput as McpToolInput,
  ToolOutput as McpToolOutput,
};

// MCP-specific header. The upstream template prints the raw MCP server name and
// monospace tool name (e.g. "UC Function: genai_uat.bb_usecases_uat.uc_disa_prg_...").
// This override renders the same friendly activity labels used for non-MCP tools
// (see TOOL_ACTIVITY in ./tool.tsx) and only flags approval states.
type McpToolHeaderProps = {
  serverName?: string;
  toolName: string;
  state: ToolState;
  // Used when state is 'approval-responded' to determine approval outcome.
  approved?: boolean;
  className?: string;
};

export const McpToolHeader = ({
  toolName,
  state,
  approved,
  className,
}: McpToolHeaderProps) => {
  const { running, done } = describeTool(String(toolName));
  const denied =
    state === 'output-denied' ||
    (state === 'approval-responded' && approved === false);
  const finished =
    state === 'output-available' ||
    (state === 'approval-responded' && approved === true);
  const pendingApproval = state === 'approval-requested';

  const text = pendingApproval
    ? `${running} — approval needed`
    : denied
      ? `${running} did not complete`
      : finished
        ? done
        : `${running}…`;

  return (
    <CollapsibleTrigger
      className={cn(
        'group flex w-full min-w-0 cursor-pointer items-center gap-2 px-3 py-2 text-left text-sm',
        className,
      )}
      title={pendingApproval ? 'Approval needed' : 'Show details'}
    >
      {pendingApproval ? (
        <ShieldAlertIcon className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
      ) : denied ? (
        <AlertCircle className="size-3.5 shrink-0 text-destructive" />
      ) : finished ? (
        <Check className="size-3.5 shrink-0 text-green-600 dark:text-green-400" />
      ) : (
        <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
      )}
      <span
        className={cn(
          'truncate text-muted-foreground',
          pendingApproval && 'text-amber-700 dark:text-amber-300',
          !finished && !denied && !pendingApproval && 'animate-pulse',
          denied && 'text-destructive',
        )}
      >
        {text}
      </span>
      <ChevronDownIcon className="ml-auto size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
    </CollapsibleTrigger>
  );
};

// MCP-specific approval actions (unchanged behavior from the upstream template).
type McpApprovalActionsProps = {
  onApprove: () => void;
  onDeny: () => void;
  isSubmitting: boolean;
};

export const McpApprovalActions = ({
  onApprove,
  onDeny,
  isSubmitting,
}: McpApprovalActionsProps) => (
  <div
    className="flex flex-col gap-3 border-amber-300 border-t bg-amber-50/50 p-3 dark:border-amber-700 dark:bg-amber-950/20"
    data-testid="mcp-approval-actions"
  >
    <div className="flex items-start gap-2">
      <ShieldAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <p className="text-amber-800 text-sm dark:text-amber-200">
        This tool requires your permission to run.
      </p>
    </div>
    <div className="flex gap-2">
      <Button
        variant="default"
        size="sm"
        onClick={onApprove}
        disabled={isSubmitting}
        className="bg-green-600 hover:bg-green-700"
        data-testid="mcp-approval-allow"
      >
        <ShieldCheckIcon className="mr-1.5 size-4" />
        {isSubmitting ? 'Submitting...' : 'Allow'}
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={onDeny}
        disabled={isSubmitting}
        data-testid="mcp-approval-deny"
      >
        <ShieldXIcon className="mr-1.5 size-4" />
        Deny
      </Button>
    </div>
  </div>
);

// MCP-specific approval status display.
type McpApprovalStatusProps = {
  approved: boolean;
  reason?: string;
};

export const McpApprovalStatus = ({
  approved,
  reason,
}: McpApprovalStatusProps) => (
  <div
    className={cn(
      'flex items-center gap-2 border-t p-3',
      approved
        ? 'border-green-300 bg-green-50/50 dark:border-green-800 dark:bg-green-950/20'
        : 'border-red-300 bg-red-50/50 dark:border-red-800 dark:bg-red-950/20',
    )}
  >
    {approved ? (
      <ShieldCheckIcon className="size-4 text-green-600 dark:text-green-400" />
    ) : (
      <ShieldXIcon className="size-4 text-red-600 dark:text-red-400" />
    )}
    <span
      className={cn(
        'text-sm',
        approved ? 'text-green-700 dark:text-green-300' : 'text-red-700 dark:text-red-300',
      )}
    >
      {approved ? 'Allowed' : 'Denied'}
    </span>
    {reason && (
      <>
        <span className="text-muted-foreground/50">•</span>
        <span className="text-muted-foreground text-sm">{reason}</span>
      </>
    )}
  </div>
);
