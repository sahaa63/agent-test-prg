import { type ComponentProps, memo } from 'react';
import { DatabricksMessageCitationStreamdownIntegration } from '../databricks-message-citation';
import { Streamdown } from 'streamdown';
import { QuickReplyChip, linkQuickReplies, quickReplyText } from './quick-reply';

// Copy of the chat template's elements/response.tsx with one addition: quoted PRG workflow
// phrases ("use defaults", "Generate a press release for [Month Year]", ...) become
// clickable chips that type the phrase into the chat box. All other links render as before.

type ResponseProps = ComponentProps<typeof Streamdown>;

function ResponseLink(props: ComponentProps<typeof DatabricksMessageCitationStreamdownIntegration>) {
  const text = quickReplyText((props as { href?: string }).href);
  if (text !== null) return <QuickReplyChip text={text} />;
  return <DatabricksMessageCitationStreamdownIntegration {...props} />;
}

export const Response = memo(
  (props: ResponseProps) => {
    const children = typeof props.children === 'string' ? linkQuickReplies(props.children) : props.children;
    return (
      <Streamdown
        components={{
          a: ResponseLink,
        }}
        className="flex flex-col gap-4"
        {...props}
      >
        {children}
      </Streamdown>
    );
  },
  (prevProps, nextProps) => prevProps.children === nextProps.children,
);

Response.displayName = 'Response';
