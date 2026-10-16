-- 0026 — Playgroup as a grade under Pre-primary.
--
-- 0024 only reads PP1, PP2 and Grades 1–12, so a student whose grade says "Playgroup" got no grade_code
-- (and no level) and was asked to pick one of those instead. This adds Playgroup (grade_code 'PG') as the
-- first Pre-primary grade, before PP1. Nothing else changes:
--   * grade_code_from_text() also reads "Playgroup", "Play group" and "PG"; every other answer is unchanged.
--   * education_level_for_grade('PG') is Pre-primary.
--   * the allowed grade_code values gain 'PG'.
--   * Pre-primary's grade range reads "Playgroup–PP2" (only if it still has 0024's text).
--   * Existing students whose grade says Playgroup get grade_code 'PG'. The grade text itself is unchanged.
-- Safe to run again.

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
  if t in ('playgroup', 'pg') then
    return 'PG';
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
    when p_code in ('PG', 'PP1', 'PP2') then 'pre_primary'
    when p_code in ('G1', 'G2', 'G3', 'G4', 'G5', 'G6') then 'primary'
    when p_code in ('G7', 'G8', 'G9') then 'junior'
    when p_code in ('G10', 'G11', 'G12') then 'senior'
    else null
  end
$$;

alter table student_profiles drop constraint if exists student_profiles_grade_code_check;
alter table student_profiles add constraint student_profiles_grade_code_check check (
  grade_code is null
  or grade_code in ('PG', 'PP1', 'PP2', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10', 'G11', 'G12')
);

update education_levels set grades = 'Playgroup–PP2' where code = 'pre_primary' and grades = 'PP1–PP2';

-- Existing students: read their grade again with the new rule (only rows whose answer changes).
update student_profiles set grade_code = grade_code_from_text(grade)
where grade_code is distinct from grade_code_from_text(grade);
