-- 0024 — School levels for Subjects (Pre-primary → Senior School).
--
-- Additive only: nothing is dropped except the old "subject names must be unique" rule, which is replaced
-- by "unique within a level" so that e.g. Mathematics can exist for Primary, Junior and Senior separately.
-- No subject, lesson or material is deleted or moved; no ids change.
--
-- 1. education_levels: the four current levels (Pre-primary, Primary (CBC), Junior School, Senior School).
-- 2. subjects.level    : which level a subject belongs to. Every existing subject becomes Primary (CBC).
--    subjects.pathway  : Senior School only (Core / STEM / Social Sciences / Arts & Sports Science); optional.
--    subjects.active   : admins hide a subject instead of deleting it.
-- 3. lessons -> subjects is now ON DELETE RESTRICT (it was CASCADE, which deleted every lesson of a deleted
--    subject). A subject that has lessons can no longer be deleted; hide it instead.
-- 4. student_profiles.grade_code: PP1, PP2, G1 … G12, worked out by the database from the existing free-text
--    grade ("Grade 6", "pp2", "class 7" …) on every save. The free-text grade column is unchanged. Anything
--    that cannot be read (e.g. "Form 2") is left empty and the student is asked to choose their grade.
--    A student's level comes from grade_code (education_level_for_grade).
-- 5. Permissions: anyone signed in reads levels and subjects; only admins change them (as before).
--
-- No new subjects are added here: the Junior/Senior (and extra Primary/Pre-primary) subject lists are
-- entered by an admin on Admin -> Subjects once approved.

-- ---------------------------------------------------------------------------------------------------------
-- 1. Levels
-- ---------------------------------------------------------------------------------------------------------
create table if not exists education_levels (
  code text primary key check (code in ('pre_primary', 'primary', 'junior', 'senior')),
  name text not null,
  grades text not null,
  order_index int not null
);

insert into education_levels (code, name, grades, order_index) values
  ('pre_primary', 'Pre-primary',   'PP1–PP2',      1),
  ('primary',     'Primary (CBC)', 'Grades 1–6',   2),
  ('junior',      'Junior School', 'Grades 7–9',   3),
  ('senior',      'Senior School', 'Grades 10–12', 4)
on conflict (code) do nothing;

alter table education_levels enable row level security;
drop policy if exists "education_levels_read_all" on education_levels;
create policy "education_levels_read_all" on education_levels for select using (auth.role() = 'authenticated');
drop policy if exists "education_levels_admin_write" on education_levels;
create policy "education_levels_admin_write" on education_levels for all using (is_admin()) with check (is_admin());

-- ---------------------------------------------------------------------------------------------------------
-- 2. Subjects: level, pathway, active
-- ---------------------------------------------------------------------------------------------------------
alter table subjects add column if not exists level text not null default 'primary' references education_levels(code);
alter table subjects add column if not exists pathway text;
alter table subjects add column if not exists active boolean not null default true;

alter table subjects drop constraint if exists subjects_pathway_check;
alter table subjects add constraint subjects_pathway_check check (
  pathway is null
  or (level = 'senior' and pathway in ('core', 'stem', 'social_sciences', 'arts_sports'))
);

-- Names are unique within a level (was: unique across everything).
alter table subjects drop constraint if exists subjects_name_key;
alter table subjects drop constraint if exists subjects_level_name_key;
alter table subjects add constraint subjects_level_name_key unique (level, name);

create index if not exists subjects_level_order_idx on subjects (level, order_index);

-- ---------------------------------------------------------------------------------------------------------
-- 3. Deleting a subject must never delete its lessons
-- ---------------------------------------------------------------------------------------------------------
alter table lessons drop constraint if exists lessons_subject_id_fkey;
alter table lessons add constraint lessons_subject_id_fkey
  foreign key (subject_id) references subjects(id) on delete restrict;

-- ---------------------------------------------------------------------------------------------------------
-- 4. Student grade -> grade_code -> level
-- ---------------------------------------------------------------------------------------------------------

-- Reads what students typed ("Grade 6", "grade6", "G 7", "Class 4", "Std 5", "PP1", "pp 2", "Pre-primary 1",
-- "10"). Returns PP1, PP2, G1 … G12, or null when it cannot tell (e.g. "Form 2", empty).
create or replace function grade_code_from_text(p_grade text) returns text
language plpgsql immutable as $$
declare
  t text := lower(regexp_replace(coalesce(p_grade, ''), '[^a-zA-Z0-9]+', '', 'g'));
  m text[];
  n int;
begin
  if t = '' then
    return null;
  end if;
  m := regexp_match(t, '^(?:pp|preprimary|preunit)([12])$');
  if m is not null then
    return 'PP' || m[1];
  end if;
  m := regexp_match(t, '^(?:grade|gr|g|class|standard|std)?([0-9]{1,2})$');
  if m is not null then
    n := m[1]::int;
    if n between 1 and 12 then
      return 'G' || n;
    end if;
  end if;
  return null;
end;
$$;

create or replace function education_level_for_grade(p_code text) returns text
language sql immutable as $$
  select case
    when p_code in ('PP1', 'PP2') then 'pre_primary'
    when p_code in ('G1', 'G2', 'G3', 'G4', 'G5', 'G6') then 'primary'
    when p_code in ('G7', 'G8', 'G9') then 'junior'
    when p_code in ('G10', 'G11', 'G12') then 'senior'
    else null
  end
$$;

alter table student_profiles add column if not exists grade_code text;
alter table student_profiles drop constraint if exists student_profiles_grade_code_check;
alter table student_profiles add constraint student_profiles_grade_code_check check (
  grade_code is null
  or grade_code in ('PP1', 'PP2', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10', 'G11', 'G12')
);

-- grade_code always follows the free-text grade; it cannot be set to something else directly.
create or replace function student_profiles_set_grade_code() returns trigger
language plpgsql as $$
begin
  new.grade_code := grade_code_from_text(new.grade);
  return new;
end;
$$;

drop trigger if exists trg_student_profiles_grade_code on student_profiles;
create trigger trg_student_profiles_grade_code
  before insert or update on student_profiles
  for each row execute function student_profiles_set_grade_code();

-- Existing students: fill grade_code from what they already typed.
update student_profiles set grade_code = grade_code_from_text(grade)
where grade_code is distinct from grade_code_from_text(grade);
