import { Card } from "@/components/ui/Card";
import { Avatar } from "@/components/ui/Avatar";
import { LinkButton } from "@/components/ui/Button";
import { MessageAction } from "@/components/directory/MessageAction";
import { subtitleOf, type DirectoryTeacher } from "@/lib/directory/rules";
import type { MessagingState } from "@/lib/messaging-permission";

/** One teacher/coach in the directory: picture, name, role, what they teach, and the two actions. */
export function TeacherCard({ teacher, messagingState }: { teacher: DirectoryTeacher; messagingState: MessagingState }) {
  const enrolledIn = teacher.activities.map((a) => a.title).join(", ");
  return (
    <li>
      <Card className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-3 sm:gap-4">
          <Avatar name={teacher.name} src={teacher.avatarSrc} size="lg" />
          <div className="min-w-0 flex-1">
            <h2 className="font-head text-base font-bold leading-tight break-words">{teacher.name}</h2>
            <p className="mt-0.5 text-sm font-medium text-ink-soft break-words">{subtitleOf(teacher)}</p>
            {enrolledIn && <p className="mt-1 line-clamp-2 text-xs text-ink-faint">You&apos;re in: {enrolledIn}</p>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2 sm:shrink-0 sm:flex-nowrap">
          <LinkButton href={`/student/teachers/${teacher.id}`} variant="outline" ariaLabel={`View profile of ${teacher.name}`}>
            View profile
          </LinkButton>
          <MessageAction teacher={teacher} messagingState={messagingState} />
        </div>
      </Card>
    </li>
  );
}
