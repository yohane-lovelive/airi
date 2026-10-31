CREATE TABLE "synced_settings_fields" (
	"owner_id" text NOT NULL,
	"document_id" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb,
	"revision" integer NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "synced_settings_fields_pk" PRIMARY KEY("owner_id","document_id","key","revision")
);
--> statement-breakpoint
CREATE TABLE "synced_settings" (
	"owner_id" text NOT NULL,
	"document_id" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	CONSTRAINT "synced_settings_pk" PRIMARY KEY("owner_id","document_id")
);
--> statement-breakpoint
ALTER TABLE "synced_settings_fields" ADD CONSTRAINT "synced_settings_fields_document_fk" FOREIGN KEY ("owner_id","document_id") REFERENCES "public"."synced_settings"("owner_id","document_id") ON DELETE cascade ON UPDATE no action;