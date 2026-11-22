CREATE TABLE "audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"actor_user_id" text,
	"actor_name" text NOT NULL,
	"actor_role" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"action" text NOT NULL,
	"detail" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "award_allocations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"award_id" text NOT NULL,
	"rfq_item_id" text NOT NULL,
	"quotation_id" text NOT NULL,
	"quotation_line_id" text NOT NULL,
	"supplier_id" text NOT NULL,
	"awarded_qty" double precision NOT NULL,
	"awarded_unit_landed" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "awards" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"rfq_id" text NOT NULL,
	"is_split_award" boolean DEFAULT false NOT NULL,
	"recommended_by" text NOT NULL,
	"recommended_by_user_id" text,
	"approved_by" text,
	"approved_by_user_id" text,
	"approval_status" text DEFAULT 'pending' NOT NULL,
	"non_l1_justification" text,
	"approver_notes" text,
	"total_awarded_landed" double precision DEFAULT 0 NOT NULL,
	"decided_at" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_items" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"sku_code" text DEFAULT '' NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"default_uom" text DEFAULT 'pcs' NOT NULL,
	"hsn_sac_code" text DEFAULT '' NOT NULL,
	"last_awarded_unit_price" double precision,
	"last_awarded_currency" text,
	"last_awarded_at" text,
	"last_supplier_id" text
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by_user_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "organization_memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"country_code" text DEFAULT 'IN' NOT NULL,
	"default_currency" text DEFAULT 'INR' NOT NULL,
	"tax_regime" text DEFAULT 'INDIA_GST' NOT NULL,
	"default_tax_creditable" boolean DEFAULT true NOT NULL,
	"uom_aliases" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "price_history" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"catalog_item_id" text NOT NULL,
	"rfq_id" text NOT NULL,
	"rfq_number" text NOT NULL,
	"supplier_id" text NOT NULL,
	"supplier_name" text NOT NULL,
	"unit_landed_price" double precision NOT NULL,
	"currency" text NOT NULL,
	"awarded_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotation_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"quotation_id" text NOT NULL,
	"rfq_item_id" text,
	"vendor_line_no" integer NOT NULL,
	"raw_description" text NOT NULL,
	"quoted_qty" double precision,
	"quoted_uom" text,
	"uom_conversion_factor" double precision DEFAULT 1 NOT NULL,
	"quoted_unit_rate" double precision,
	"discount_amount" double precision DEFAULT 0 NOT NULL,
	"tax_rate_pct" double precision DEFAULT 0 NOT NULL,
	"tax_creditable" boolean DEFAULT true NOT NULL,
	"allocated_overhead" double precision DEFAULT 0 NOT NULL,
	"normalized_unit_base" double precision,
	"normalized_unit_landed" double precision,
	"normalized_unit_gross" double precision,
	"line_total_quoted" double precision,
	"expected_line_total" double precision,
	"math_valid" boolean DEFAULT true NOT NULL,
	"math_error_detail" text,
	"match_status" text DEFAULT 'unmapped' NOT NULL,
	"confidence_score" double precision DEFAULT 0.85 NOT NULL,
	"human_edited" boolean DEFAULT false NOT NULL,
	"verified_field" boolean DEFAULT false NOT NULL,
	"source_trace" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"rfq_id" text NOT NULL,
	"supplier_id" text NOT NULL,
	"document_id" text,
	"document_name" text NOT NULL,
	"document_kind" text NOT NULL,
	"mime_type" text NOT NULL,
	"raw_email_text" text,
	"sheet_preview" jsonb,
	"parse_status" text DEFAULT 'needs_review' NOT NULL,
	"quote_reference" text NOT NULL,
	"quote_date" text,
	"valid_until" text,
	"currency" text DEFAULT 'INR' NOT NULL,
	"exchange_rate_to_rfq" double precision DEFAULT 1 NOT NULL,
	"lead_time_days" integer,
	"payment_terms" text,
	"freight_charges" double precision DEFAULT 0 NOT NULL,
	"packing_forwarding" double precision DEFAULT 0 NOT NULL,
	"other_charges" double precision DEFAULT 0 NOT NULL,
	"global_discount" double precision DEFAULT 0 NOT NULL,
	"tax_included_in_rates" boolean DEFAULT false NOT NULL,
	"missing_freight_warning" boolean DEFAULT false NOT NULL,
	"subtotal_base" double precision DEFAULT 0 NOT NULL,
	"total_tax" double precision DEFAULT 0 NOT NULL,
	"total_landed_cost" double precision DEFAULT 0 NOT NULL,
	"total_gross_payable" double precision DEFAULT 0 NOT NULL,
	"completeness_ratio" double precision DEFAULT 0 NOT NULL,
	"is_verified" boolean DEFAULT false NOT NULL,
	"verified_by" text,
	"verified_at" text,
	"header_traces" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit_buckets" (
	"bucket_key" text PRIMARY KEY NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	"reset_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rfq_items" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"rfq_id" text NOT NULL,
	"item_id" text,
	"line_no" integer NOT NULL,
	"sku_code" text DEFAULT '' NOT NULL,
	"description" text NOT NULL,
	"quantity" double precision NOT NULL,
	"uom" text DEFAULT 'pcs' NOT NULL,
	"target_unit_price" double precision
);
--> statement-breakpoint
CREATE TABLE "rfqs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"rfq_number" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'collecting' NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"incoterms" text DEFAULT 'FOR Destination' NOT NULL,
	"delivery_location" text DEFAULT '' NOT NULL,
	"deadline_date" text NOT NULL,
	"created_by" text NOT NULL,
	"created_by_user_id" text,
	"invited_supplier_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"active_organization_id" text,
	"token_hash" text NOT NULL,
	"csrf_token" text NOT NULL,
	"auth_method" text DEFAULT 'password' NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "stored_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"uploaded_by_user_id" text,
	"storage_provider" text NOT NULL,
	"storage_key" text NOT NULL,
	"original_filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "stored_documents_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"tax_id" text DEFAULT '' NOT NULL,
	"city" text DEFAULT '' NOT NULL,
	"contact_name" text DEFAULT '' NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"phone_whatsapp" text DEFAULT '' NOT NULL,
	"default_payment_terms" text DEFAULT 'Net 30 Days' NOT NULL,
	"categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"firebase_uid" text,
	"email" text NOT NULL,
	"password_hash" text,
	"full_name" text NOT NULL,
	"title" text DEFAULT 'Procurement Member' NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"email_verification_token_hash" text,
	"email_verification_expires_at" timestamp with time zone,
	"password_reset_token_hash" text,
	"password_reset_expires_at" timestamp with time zone,
	"last_active_org_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_firebase_uid_unique" UNIQUE("firebase_uid"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "award_allocations" ADD CONSTRAINT "award_allocations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "award_allocations" ADD CONSTRAINT "award_allocations_award_id_awards_id_fk" FOREIGN KEY ("award_id") REFERENCES "public"."awards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "award_allocations" ADD CONSTRAINT "award_allocations_rfq_item_id_rfq_items_id_fk" FOREIGN KEY ("rfq_item_id") REFERENCES "public"."rfq_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "award_allocations" ADD CONSTRAINT "award_allocations_quotation_id_quotations_id_fk" FOREIGN KEY ("quotation_id") REFERENCES "public"."quotations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "award_allocations" ADD CONSTRAINT "award_allocations_quotation_line_id_quotation_lines_id_fk" FOREIGN KEY ("quotation_line_id") REFERENCES "public"."quotation_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "award_allocations" ADD CONSTRAINT "award_allocations_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "awards" ADD CONSTRAINT "awards_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "awards" ADD CONSTRAINT "awards_rfq_id_rfqs_id_fk" FOREIGN KEY ("rfq_id") REFERENCES "public"."rfqs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "awards" ADD CONSTRAINT "awards_recommended_by_user_id_users_id_fk" FOREIGN KEY ("recommended_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "awards" ADD CONSTRAINT "awards_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_items" ADD CONSTRAINT "catalog_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_items" ADD CONSTRAINT "catalog_items_last_supplier_id_suppliers_id_fk" FOREIGN KEY ("last_supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_history" ADD CONSTRAINT "price_history_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_history" ADD CONSTRAINT "price_history_catalog_item_id_catalog_items_id_fk" FOREIGN KEY ("catalog_item_id") REFERENCES "public"."catalog_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_quotation_id_quotations_id_fk" FOREIGN KEY ("quotation_id") REFERENCES "public"."quotations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_rfq_item_id_rfq_items_id_fk" FOREIGN KEY ("rfq_item_id") REFERENCES "public"."rfq_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_rfq_id_rfqs_id_fk" FOREIGN KEY ("rfq_id") REFERENCES "public"."rfqs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_document_id_stored_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."stored_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfq_items" ADD CONSTRAINT "rfq_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfq_items" ADD CONSTRAINT "rfq_items_rfq_id_rfqs_id_fk" FOREIGN KEY ("rfq_id") REFERENCES "public"."rfqs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfq_items" ADD CONSTRAINT "rfq_items_item_id_catalog_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."catalog_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_active_organization_id_organizations_id_fk" FOREIGN KEY ("active_organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stored_documents" ADD CONSTRAINT "stored_documents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stored_documents" ADD CONSTRAINT "stored_documents_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_org_created_idx" ON "audit_logs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "award_allocations_org_award_idx" ON "award_allocations" USING btree ("organization_id","award_id");--> statement-breakpoint
CREATE INDEX "award_allocations_quote_idx" ON "award_allocations" USING btree ("quotation_id");--> statement-breakpoint
CREATE INDEX "awards_org_rfq_idx" ON "awards" USING btree ("organization_id","rfq_id");--> statement-breakpoint
CREATE INDEX "catalog_items_org_idx" ON "catalog_items" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "catalog_items_org_norm_idx" ON "catalog_items" USING btree ("organization_id","normalized_name");--> statement-breakpoint
CREATE INDEX "invitations_org_email_idx" ON "invitations" USING btree ("organization_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "org_memberships_org_user_uidx" ON "organization_memberships" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "org_memberships_user_idx" ON "organization_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "price_history_org_item_idx" ON "price_history" USING btree ("organization_id","catalog_item_id");--> statement-breakpoint
CREATE INDEX "quotation_lines_org_quote_idx" ON "quotation_lines" USING btree ("organization_id","quotation_id");--> statement-breakpoint
CREATE INDEX "quotations_org_rfq_idx" ON "quotations" USING btree ("organization_id","rfq_id");--> statement-breakpoint
CREATE INDEX "quotations_org_sup_idx" ON "quotations" USING btree ("organization_id","supplier_id");--> statement-breakpoint
CREATE INDEX "rfq_items_org_rfq_idx" ON "rfq_items" USING btree ("organization_id","rfq_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rfqs_org_number_uidx" ON "rfqs" USING btree ("organization_id","rfq_number");--> statement-breakpoint
CREATE INDEX "rfqs_org_idx" ON "rfqs" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "sessions_user_exp_idx" ON "sessions" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE INDEX "stored_documents_org_idx" ON "stored_documents" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "suppliers_org_idx" ON "suppliers" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "suppliers_org_name_idx" ON "suppliers" USING btree ("organization_id","name");