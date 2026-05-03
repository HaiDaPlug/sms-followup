alter table review_items
  add column if not exists content_hash text;

create unique index if not exists review_items_content_hash_idx
  on review_items (content_hash)
  where content_hash is not null;
