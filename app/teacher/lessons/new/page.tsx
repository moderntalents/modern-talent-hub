import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { NewLessonForm } from "./NewLessonForm";

export default async function NewLessonPage() {
  const supabase = await createClient();
  const { data: subjects } = await supabase.from("subjects").select("id, name").order("order_index");

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-4">
      <h1 className="font-head text-xl font-extrabold">New lesson</h1>
      <Card>
        <NewLessonForm subjects={subjects ?? []} />
      </Card>
    </div>
  );
}
