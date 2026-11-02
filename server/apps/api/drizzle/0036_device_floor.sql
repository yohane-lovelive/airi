CREATE TABLE "device_floor" (
	"owner_id" text PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"claimed_at" timestamp NOT NULL,
	"heartbeat_at" timestamp NOT NULL
);
