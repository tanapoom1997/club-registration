import { useEffect, useId, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

// The clamped box is a pixel or so shorter than its content at some zoom levels without hiding a
// line; a whole hidden line is far more than this.
const CLAMP_SLACK_PX = 1;

type ClubDescriptionProps = {
  description: string;
  // Told apart on every card for a screen reader (the visible text starts the name).
  clubLabel: string;
};

// A long description shows its first three lines on a phone, where a round of 30+ clubs is one
// column and a student's turn in the queue is limited, with a button to show the rest. From sm up
// it is shown whole, as before. The button appears only when the clamp hides something, measured
// on the box itself, so a short description is never given a button that does nothing. The text
// is all in the page for a screen reader either way: the clamp only hides it from view.
export const ClubDescription = ({ description, clubLabel }: ClubDescriptionProps) => {
  const id = useId();
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element || expanded) return undefined;
    const update = () => setClamped(element.scrollHeight > element.clientHeight + CLAMP_SLACK_PX);
    update();
    // The width decides how many lines the text takes (a turned phone, a resized window, the font
    // arriving); absent in jsdom, where the first measure is all there is.
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [description, expanded]);

  const toggleText = expanded ? 'ย่อ' : 'อ่านต่อ';
  return (
    <div className="space-y-1">
      <p
        ref={ref}
        id={id}
        className={cn(
          'text-sm break-words whitespace-pre-line text-muted-foreground',
          !expanded && 'max-sm:line-clamp-3',
        )}
      >
        {description}
      </p>
      {(clamped || expanded) && (
        <button
          type="button"
          className="-my-2 inline-flex min-h-11 items-center text-sm font-medium text-primary underline-offset-4 hover:underline sm:hidden"
          aria-expanded={expanded}
          aria-controls={id}
          aria-label={`${toggleText} รายละเอียดชุมนุม ${clubLabel}`}
          onClick={() => setExpanded((open) => !open)}
        >
          {toggleText}
        </button>
      )}
    </div>
  );
};
