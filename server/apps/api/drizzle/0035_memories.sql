CREATE TABLE "memories" (
	"owner_id" text NOT NULL,
	"document_id" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	CONSTRAINT "memories_pk" PRIMARY KEY("owner_id","document_id")
);
--> statement-breakpoint
CREATE TABLE "memory_fields" (
	"owner_id" text NOT NULL,
	"document_id" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb,
	"revision" integer NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "memory_fields_pk" PRIMARY KEY("owner_id","document_id","key","revision")
);
--> statement-breakpoint
CREATE TABLE "memory_vectors" (
	"owner_id" text NOT NULL,
	"document_id" text NOT NULL,
	"revision" integer NOT NULL,
	"persona" text,
	"content_hash" text NOT NULL,
	"model" text NOT NULL,
	"embedding" vector(256) NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "memory_vectors_pk" PRIMARY KEY("owner_id","document_id")
);
--> statement-breakpoint
ALTER TABLE "memory_fields" ADD CONSTRAINT "memory_fields_document_fk" FOREIGN KEY ("owner_id","document_id") REFERENCES "public"."memories"("owner_id","document_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_vectors" ADD CONSTRAINT "memory_vectors_document_fk" FOREIGN KEY ("owner_id","document_id") REFERENCES "public"."memories"("owner_id","document_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_vectors_owner_persona_idx" ON "memory_vectors" USING btree ("owner_id","persona");