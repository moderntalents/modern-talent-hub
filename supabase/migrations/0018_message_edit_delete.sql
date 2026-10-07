-- Modern Talent Hub — edit and delete your own messages.
-- Run after 0017_b2c_reconciliation.sql. Adds two columns and two functions; nothing is removed.
--
-- Rules (decided with the site owner):
--   * A person can edit or delete ONLY a message they sent. The database checks this itself, so a
--     bug in application code can never let one person change the other person's words.
--   * Editing changes the text only (a PDF can't be swapped), keeps the message's place in the
--     conversation, and stamps edited_at so both people see an "Edited" label. Saving text that is
--     unchanged is not an edit. Editing follows the same rules as sending: it is refused while the
--     conversation is closed or paused, exactly like a new message.
--   * Deleting erases the CONTENT but keeps the row: the text is wiped, any attached PDF is detached
--     (the server then removes the file from storage) and deleted_at is set, so the other person
--     sees "This message was deleted" instead of a gap in the conversation. Deleting your own
--     message stays possible after a conversation has closed, so a person can always take their
--     own words back; it is refused only where the person couldn't read the thread at all.
--   * Same security model as 0011: no browser can write to messages. Both functions are callable
--     by the server (service role) only, and they re-check who is asking on every call. A person
--     who is not in the conversation gets "message not found", never a hint that it exists.

-- ------------------------------------------------------------
-- Columns
-- ------------------------------------------------------------

alter table messages
  add column edited_at  timestamptz,
  add column deleted_at timestamptz;

-- A deleted message has no content left, so the "at least one visible character" rule from 0011
-- must let it through — and only it.
alter table messages drop constraint messages_has_content;
alter table messages add constraint messages_has_content check (
  deleted_at is not null
  or body ~ '[^\s ​　]'
  or attachment_path is not null
);

-- A deleted message really is empty: nothing of the original text or file may remain on the row.
alter table messages add constraint messages_deleted_is_empty check (
  deleted_at is null
  or (body = '' and attachment_path is null and attachment_name is null and attachment_size is null and edited_at is null)
);

-- ------------------------------------------------------------
-- Editing
-- ------------------------------------------------------------

-- 'edited' or 'unchanged'. Raises messaging:<reason> when it isn't allowed:
--   message_not_found  no such message, or the caller isn't in its conversation
--   not_yours          the caller is in the conversation but didn't send this message
--   message_deleted    the message was deleted
--   closed / not_cleared / awaiting_student   the same reasons sending can be refused (see messaging_can_send)
--   too_long / edit_empty   the new text breaks the same limits as a new message
create or replace function edit_message(p_user uuid, p_message uuid, p_body text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  m messages%rowtype;
  c conversations%rowtype;
  v_status text;
  v_body text := regexp_replace(coalesce(p_body, ''), '^[\s ​　]+|[\s ​　]+$', '', 'g');
begin
  -- Lock the message so two changes to it at once are applied one after the other.
  select * into m from messages where id = p_message for update;
  if not found then
    raise exception 'messaging:message_not_found';
  end if;

  select * into c from conversations where id = m.conversation_id;
  if p_user is null or p_user not in (c.student_id, c.teacher_id) then
    raise exception 'messaging:message_not_found';
  end if;
  if m.sender_id <> p_user then
    raise exception 'messaging:not_yours';
  end if;
  if m.deleted_at is not null then
    raise exception 'messaging:message_deleted';
  end if;

  v_status := messaging_can_send(p_user, m.conversation_id);
  if v_status <> 'ok' then
    raise exception 'messaging:%', v_status;
  end if;

  if char_length(v_body) > 2000 then
    raise exception 'messaging:too_long';
  end if;
  -- Without a PDF a message needs text; with one, the text may be removed and the file stays.
  if v_body = '' and m.attachment_path is null then
    raise exception 'messaging:edit_empty';
  end if;

  if v_body = m.body then
    return 'unchanged';
  end if;

  update messages set body = v_body, edited_at = now() where id = m.id;
  return 'edited';
end;
$$;

-- ------------------------------------------------------------
-- Deleting
-- ------------------------------------------------------------

-- Erases the message's content (see the rules above) and returns the storage path of the PDF that
-- was attached, or null if there was none (or it was already deleted — deleting twice is harmless).
-- The server removes that file from the private bucket afterwards. Raises the same
-- message_not_found / not_yours reasons as edit_message, and not_cleared when the person couldn't
-- read the thread at all. A closed conversation still allows deleting your own message.
create or replace function delete_message(p_user uuid, p_message uuid)
returns text
language plpgsql security definer set search_path = public as $$
declare
  m messages%rowtype;
  c conversations%rowtype;
  v_status text;
begin
  select * into m from messages where id = p_message for update;
  if not found then
    raise exception 'messaging:message_not_found';
  end if;

  select * into c from conversations where id = m.conversation_id;
  if p_user is null or p_user not in (c.student_id, c.teacher_id) then
    raise exception 'messaging:message_not_found';
  end if;
  if m.sender_id <> p_user then
    raise exception 'messaging:not_yours';
  end if;

  v_status := messaging_can_send(p_user, m.conversation_id);
  if v_status in ('not_found', 'not_cleared') then
    raise exception 'messaging:%', v_status;
  end if;

  if m.deleted_at is not null then
    return null;
  end if;

  update messages
     set body = '',
         attachment_path = null,
         attachment_name = null,
         attachment_size = null,
         edited_at = null,
         deleted_at = now()
   where id = m.id;
  return m.attachment_path;
end;
$$;

-- ------------------------------------------------------------
-- Who can call them: the server only (the same as every other messaging function)
-- ------------------------------------------------------------

revoke all on function edit_message(uuid, uuid, text) from public, anon, authenticated;
revoke all on function delete_message(uuid, uuid) from public, anon, authenticated;

grant execute on function edit_message(uuid, uuid, text) to service_role;
grant execute on function delete_message(uuid, uuid) to service_role;
