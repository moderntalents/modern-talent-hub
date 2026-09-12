import { Card } from "@/components/ui/Card";
import { NewActivityForm } from "./NewActivityForm";

export default function NewActivityPage() {
  return (
    <div className="mx-auto flex max-w-lg flex-col gap-4">
      <h1 className="font-head text-xl font-extrabold">New activity</h1>
      <Card>
        <NewActivityForm />
      </Card>
    </div>
  );
}
