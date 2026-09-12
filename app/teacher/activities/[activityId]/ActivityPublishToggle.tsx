"use client";

import { useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { setActivityStatus } from "./actions";

export function ActivityPublishToggle({ activityId, status }: { activityId: string; status: "draft" | "published" }) {
  const [pending, startTransition] = useTransition();

  return (
    <Button
      variant={status === "published" ? "outline" : "primary"}
      loading={pending}
      onClick={() =>
        startTransition(() => setActivityStatus(activityId, status === "published" ? "draft" : "published"))
      }
    >
      {status === "published" ? "Unpublish" : "Publish activity"}
    </Button>
  );
}
