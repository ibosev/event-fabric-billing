-- Application-owned mutable data, separate from the Event log and Readmodels.
CREATE TABLE IF NOT EXISTS settings (
  tenant text NOT NULL,
  key varchar(64) COLLATE "C" NOT NULL CHECK (key ~ '^[a-z][a-zA-Z0-9._-]{0,63}$'),
  value varchar(4096) NOT NULL,
  PRIMARY KEY (tenant, key)
);
