-- The account's email IS its identity (and its label): it must be present and
-- unique. Backfill before adding the unique index (and afterwards the label
-- is always kept equal to the email):
--   1) rows without an email get their (unique) label as the email, so the
--      user keeps the familiar identity shown in the UI;
--   2) any remaining duplicates keep the earliest row; later rows get unique
--      placeholders (the old optional-email UI could create two rows for the
--      same person — the survivor is the one created first).
UPDATE accounts
SET display_email = label
WHERE display_email IS NULL OR trim(display_email) = '';

UPDATE accounts
SET display_email = 'dup-' || substr(id, 4) || '@local'
WHERE display_email <> ''
  AND id NOT IN (
    SELECT id
    FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY display_email ORDER BY id) AS rn
      FROM accounts
    )
    WHERE rn = 1
  );

CREATE UNIQUE INDEX uq_accounts_display_email ON accounts(display_email);

-- The label is always the email.
UPDATE accounts
SET label = display_email
WHERE label <> display_email;
