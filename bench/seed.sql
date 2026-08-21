-- The table the bench reads: same columns as the HttpArena dataset, 50k synthetic rows.
CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    price INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    active BOOLEAN NOT NULL,
    tags JSONB NOT NULL,
    rating_score INTEGER NOT NULL,
    rating_count INTEGER NOT NULL
);
INSERT INTO items
SELECT i,
       'Item ' || i,
       (ARRAY['home', 'books', 'office', 'toys', 'sports'])[1 + i % 5],
       i % 500,
       i % 1000,
       i % 2 = 0,
       '["bench"]'::jsonb,
       i % 50,
       i % 500
FROM generate_series(1, 50000) AS i
ON CONFLICT (id) DO NOTHING;
