"use client";

import { useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { setLessonStatus } from "./actions";

export function PublishToggle({ lessonId, status }: { lessonId: string; status: "draft" | "published" }) {
  const [pending, startTransition] = useTransition();

  return (
    <Button
      variant={status === "published" ? "outline" : "primary"}
      loading={pending}
      onClick={() =>
        startTransition(() => setLessonStatus(lessonId, status === "published" ? "draft" : "published"))
      }
    >
      {status === "published" ? "Unpublish" : "Publish lesson"}
    </Button>
  );
}
