CREATE TABLE IF NOT EXISTS bot_tactics (
  tier INTEGER NOT NULL, field INTEGER NOT NULL, tactic TEXT NOT NULL,
  games REAL NOT NULL, reward REAL NOT NULL,
  PRIMARY KEY (tier,field,tactic)
);
CREATE TABLE IF NOT EXISTS bot_training_events (
  id TEXT PRIMARY KEY, tier INTEGER NOT NULL, field INTEGER NOT NULL,
  tactic TEXT NOT NULL, reward REAL NOT NULL
);
CREATE TRIGGER IF NOT EXISTS aggregate_bot_training
AFTER INSERT ON bot_training_events
BEGIN
  INSERT INTO bot_tactics (tier,field,tactic,games,reward)
  VALUES (NEW.tier,NEW.field,NEW.tactic,1,NEW.reward)
  ON CONFLICT (tier,field,tactic) DO UPDATE SET
    games=CASE WHEN games>=80 THEN games*.95 ELSE games END + 1,
    reward=CASE WHEN games>=80 THEN reward*.95 ELSE reward END + NEW.reward;
END;
