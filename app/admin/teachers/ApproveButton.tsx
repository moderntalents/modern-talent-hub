"use client";

import { useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { setTeacherApproval } from "./actions";

export function ApproveButton({ profileId, approved }: { profileId: string; approved: boolean }) {
  const [pending, startTransition] = useTransition();

  return (
    <Button
      variant={approved ? "outline" : "primary"}
      loading={pending}
      onClick={() => startTransition(() => setTeacherApproval(profileId, !approved))}
    >
      {approved ? "Revoke approval" : "Approve"}
    </Button>
  );
}
