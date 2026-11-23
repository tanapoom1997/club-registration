import { cn } from '@/lib/utils';

// A grey bar standing in for a line of text.
const Bar = ({ className }: { className: string }) => (
  <div className={cn('rounded-full bg-muted', className)} />
);

const RoundCardShape = () => (
  <div className="space-y-3 rounded-2xl border border-border bg-card p-5 shadow-card">
    <Bar className="h-5 w-48" />
    <Bar className="h-4 w-36" />
    <Bar className="h-4 w-56" />
    <Bar className="h-4 w-52" />
  </div>
);

const ClubCardShape = () => (
  <div className="space-y-3 rounded-2xl border border-border bg-card p-5 shadow-card">
    <Bar className="h-3.5 w-12" />
    <Bar className="h-5 w-3/4" />
    <div className="flex items-center justify-between">
      <Bar className="h-5 w-24" />
      <Bar className="h-3.5 w-14" />
    </div>
    <Bar className="h-1.5 w-full" />
    <Bar className="h-4 w-2/3" />
    <div className="h-11 rounded-lg bg-muted sm:h-10" />
  </div>
);

const ResultCardShape = () => (
  <div className="space-y-3 rounded-2xl border border-border bg-card p-5 shadow-card">
    <Bar className="h-3.5 w-20" />
    <Bar className="h-5 w-56" />
    <Bar className="h-4 w-44" />
    <div className="h-11 w-36 rounded-lg bg-muted sm:h-10" />
  </div>
);

// 'clubs-page': the round card and the club list; 'clubs': the list alone (the round is already
// on screen); 'result': the round card and the student's own club.
export type SkeletonShape = 'clubs-page' | 'clubs' | 'result';

const ClubGridShape = () => (
  <div className="grid gap-3 md:grid-cols-2">
    <ClubCardShape />
    <ClubCardShape />
    <ClubCardShape />
    <ClubCardShape />
  </div>
);

// The outline of what is loading while a student page waits for its data: on the day hundreds
// open the page at once, and a page that already has its shape feels faster than a line of
// "loading" text. Decorative and hidden from screen readers, which get the words instead; the
// pulse stops for reduced motion.
export const StudentSkeleton = ({ shape }: { shape: SkeletonShape }) => (
  <div>
    <p className="sr-only">กำลังโหลด…</p>
    <div aria-hidden="true" className="space-y-4 motion-safe:animate-pulse">
      {shape !== 'clubs' && <RoundCardShape />}
      {shape === 'result' ? (
        <ResultCardShape />
      ) : (
        <>
          {shape === 'clubs' && (
            <div className="flex gap-2">
              <div className="h-11 flex-1 rounded-lg bg-muted sm:h-10" />
              <div className="h-11 w-28 rounded-lg bg-muted sm:h-10" />
            </div>
          )}
          <ClubGridShape />
        </>
      )}
    </div>
  </div>
);
