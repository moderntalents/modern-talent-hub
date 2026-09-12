import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";

export default async function SubjectsPage() {
  const supabase = await createClient();
  const { data: subjects } = await supabase.from("subjects").select("*").order("order_index");

  return (
    <div className="flex flex-col gap-4">
      <h1 className="font-head text-xl font-extrabold">CBC Subjects</h1>
      {subjects && subjects.length > 0 ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {subjects.map((subject) => (
            <Link key={subject.id} href={`/student/subjects/${subject.id}`}>
              <Card className="flex h-full flex-col gap-2">
                <span
                  className="h-2 w-8 rounded-full"
                  style={{ background: `var(--${subject.color})` }}
                />
                <p className="font-semibold">{subject.name}</p>
              </Card>
            </Link>
          ))}
        </div>
      ) : (
        <EmptyState title="No subjects yet" description="An admin needs to add CBC subjects." />
      )}
    </div>
  );
}
