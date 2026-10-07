import { Card } from "@/components/ui/Card";
import { Avatar } from "@/components/ui/Avatar";
import { LinkButton } from "@/components/ui/Button";
import { MessageAction } from "@/components/directory/MessageAction";
import { CARD_ACTIVITY_LIMIT, subtitleOf, type DirectoryTeacher } from "@/lib/directory/rules";
import type { MessagingState } from "@/lib/messaging-permission";

/**
 * One teacher/coach: a big picture (their initials when there is none), name, role and specialty, and
 * the two actions. Built to sit two to a row on a phone and three on a desktop, so the face is the
 * first thing a student sees. Nothing private is ever on a card (see lib/directory/service.ts).
 */
export function TeacherCard({ teacher, messagingState }: { teacher: DirectoryTeacher; messagingState: MessagingState }) {
  const profileHref = `/student/teachers/${teacher.id}`;
  const shown = teacher.activities.slice(0, CARD_ACTIVITY_LIMIT).map((a) => a.title);
  const more = teacher.activities.length - shown.length;
  return (
    <li className="min-w-0">
      <Card className="flex h-full min-w-0 flex-col items-center gap-3 p-3 text-center sm:p-4">
        <a href={profileHref} aria-hidden="true" className="rounded-full" tabIndex={-1}>
          <Avatar name={teacher.name} src={teacher.avatarSrc} size="card" />
        </a>
        <div className="min-w-0 max-w-full flex-1">
          <h3 className="font-head text-sm font-bold leading-tight break-words sm:text-base">{teacher.name}</h3>
          <p className="mt-0.5 text-xs font-medium text-ink-soft break-words sm:text-sm">{subtitleOf(teacher)}</p>
          {shown.length > 0 && (
            <p className="mt-1 line-clamp-2 text-xs text-ink-faint break-words">
              {shown.join(", ")}
              {more > 0 ? ` +${more} more` : ""}
            </p>
          )}
        </div>
        <div className="flex w-full flex-col gap-2">
          <LinkButton href={profileHref} variant="outline" compact className="w-full" ariaLabel={`View profile of ${teacher.name}`}>
            View profile
          </LinkButton>
          <MessageAction teacher={teacher} messagingState={messagingState} compact />
        </div>
      </Card>
    </li>
  );
}
