
CREATE TABLE creators (id INT PRIMARY KEY, handle TEXT);
ALTER TABLE creators ENABLE ROW LEVEL SECURITY;

INSERT INTO creators SELECT g, 'creator_' || g FROM generate_series(1, 50000) g;

CREATE TABLE posts (
  id BIGINT, creator_id INT, campaign_id INT,
  status TEXT, engagement INT, created_at TIMESTAMPTZ
);
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;

INSERT INTO posts
SELECT g, 1 + (random()*49999)::INT, 1 + (random()*50)::INT,
  CASE WHEN random() < 0.05 THEN 'pending' ELSE 'settled' END,
  (random()*random()*100000)::INT,
  now() - (random() * INTERVAL '365 days')
FROM generate_series(1, 1000000) g;

ANALYZE posts;  -- gotcha #2: fresh stats, or planner flies blind